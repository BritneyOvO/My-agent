from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

from .models import Credentials, PlatformConfig, to_plain
from .registry import create_client, ensure_builtin_adapters_loaded, list_platforms, registry

try:
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel, Field
except ImportError as exc:  # pragma: no cover - only hit when API extras absent
    raise RuntimeError("API server requires fastapi and uvicorn. Install with: pip install -e .") from exc


DATA_DIR = Path(os.environ.get("CTF_PLATFORM_DATA_DIR", ".runtime")).resolve()
SESSION_DIR = DATA_DIR / "sessions"
DOWNLOAD_DIR = DATA_DIR / "downloads"
SECRET_KEYS = {
    "password",
    "token",
    "csrf_nonce",
    "csrfNonce",
    "session",
    "cookies",
    "cookie",
    "Authorization",
    "authorization",
    "cr_jwttoken",
}


class AuthBody(BaseModel):
    username: str | None = None
    password: str | None = None
    token: str | None = None
    remember: bool = True
    captcha_token: str | None = None


class SessionCreate(BaseModel):
    platform: str = Field(..., examples=["ctfd", "gzctf", "nssctf", "adworld", "ctfplus"])
    base_url: str | None = None
    auth: AuthBody
    timeout: int = 20
    verify: bool = True
    debug: bool = False


class SubmitBody(BaseModel):
    flag: str


class JoinBody(BaseModel):
    team_id: str | int | None = None
    invite_code: str | None = None


def redact(obj: Any) -> Any:
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if str(k) in SECRET_KEYS or any(x in str(k).lower() for x in ("token", "cookie", "csrf", "password")):
                out[k] = "<redacted>" if v not in (None, "", [], {}) else v
            else:
                out[k] = redact(v)
        return out
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    return obj


def session_meta_path(session_id: str) -> Path:
    return SESSION_DIR / f"{session_id}.meta.json"


def session_cache_path(session_id: str) -> Path:
    return SESSION_DIR / f"{session_id}.session.json"


def load_meta(session_id: str) -> dict[str, Any]:
    path = session_meta_path(session_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="session not found")
    return json.loads(path.read_text(encoding="utf-8"))


def client_from_meta(session_id: str):
    meta = load_meta(session_id)
    cfg = PlatformConfig(
        base_url=meta.get("base_url"),
        timeout=int(meta.get("timeout") or 20),
        verify=bool(meta.get("verify", True)),
        debug=bool(meta.get("debug", False)),
        session_file=str(session_cache_path(session_id)),
    )
    client = create_client(meta["platform"], cfg)
    client.load_session(cfg.session_file)
    return client


def save_meta(session_id: str, payload: SessionCreate) -> None:
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    meta = {
        "session_id": session_id,
        "platform": payload.platform,
        "base_url": payload.base_url,
        "timeout": payload.timeout,
        "verify": payload.verify,
        "debug": payload.debug,
    }
    session_meta_path(session_id).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


app = FastAPI(title="CTF Platform Manager API", version="0.1.0")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True}


@app.get("/api/platforms")
def platforms() -> dict[str, Any]:
    ensure_builtin_adapters_loaded()
    return {"platforms": list_platforms(), "aliases": registry.aliases()}


@app.post("/api/sessions")
def create_session(payload: SessionCreate) -> dict[str, Any]:
    session_id = uuid.uuid4().hex
    save_meta(session_id, payload)
    client = create_client(
        payload.platform,
        PlatformConfig(
            base_url=payload.base_url,
            timeout=payload.timeout,
            verify=payload.verify,
            debug=payload.debug,
            session_file=str(session_cache_path(session_id)),
        ),
    )
    auth = payload.auth
    try:
        result = client.login(
            Credentials(
                username=auth.username,
                password=auth.password,
                token=auth.token,
                remember=auth.remember,
                captcha_token=auth.captcha_token,
            )
        )
    except Exception as exc:
        session_meta_path(session_id).unlink(missing_ok=True)
        session_cache_path(session_id).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"{exc.__class__.__name__}: {exc}") from exc
    return {"session_id": session_id, "result": redact(to_plain(result))}


@app.get("/api/sessions/{session_id}/me")
def me(session_id: str) -> Any:
    return redact(to_plain(client_from_meta(session_id).current_user()))


@app.get("/api/sessions/{session_id}/contests")
def contests(session_id: str, page: int = 1, page_size: int = 50, search: str | None = None, public: bool | None = None) -> Any:
    return to_plain(client_from_meta(session_id).list_contests(page=page, page_size=page_size, search=search, public=public))


@app.get("/api/sessions/{session_id}/contests/{contest_id}")
def contest(session_id: str, contest_id: str) -> Any:
    return to_plain(client_from_meta(session_id).get_contest(contest_id))


@app.post("/api/sessions/{session_id}/contests/{contest_id}/join")
def join(session_id: str, contest_id: str, body: JoinBody | None = None) -> Any:
    body = body or JoinBody()
    return to_plain(client_from_meta(session_id).join_contest(contest_id, team_id=body.team_id, invite_code=body.invite_code))


@app.get("/api/sessions/{session_id}/challenges")
def challenges(
    session_id: str,
    contest_id: str | None = None,
    page: int = 1,
    page_size: int = 50,
    search: str | None = None,
) -> Any:
    try:
        return to_plain(client_from_meta(session_id).list_challenges(contest_id=contest_id, page=page, page_size=page_size, search=search))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"{exc.__class__.__name__}: {exc}") from exc


@app.get("/api/sessions/{session_id}/challenges/{challenge_id}")
def challenge(session_id: str, challenge_id: str, contest_id: str | None = None) -> Any:
    try:
        return to_plain(client_from_meta(session_id).get_challenge(challenge_id, contest_id=contest_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"{exc.__class__.__name__}: {exc}") from exc


@app.post("/api/sessions/{session_id}/challenges/{challenge_id}/download")
def download(session_id: str, challenge_id: str, contest_id: str | None = None) -> Any:
    outdir = DOWNLOAD_DIR / session_id / str(challenge_id)
    return to_plain(client_from_meta(session_id).download_attachment(challenge_id, str(outdir), contest_id=contest_id))


@app.post("/api/sessions/{session_id}/challenges/{challenge_id}/target")
def start_target(session_id: str, challenge_id: str, contest_id: str | None = None) -> Any:
    try:
        return to_plain(client_from_meta(session_id).start_target(challenge_id, contest_id=contest_id))
    except NotImplementedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(status_code=400, detail=f"{exc.__class__.__name__}: {exc}") from exc


@app.delete("/api/sessions/{session_id}/challenges/{challenge_id}/target")
def close_target(session_id: str, challenge_id: str, contest_id: str | None = None) -> Any:
    try:
        return to_plain(client_from_meta(session_id).close_target(challenge_id, contest_id=contest_id))
    except NotImplementedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(status_code=400, detail=f"{exc.__class__.__name__}: {exc}") from exc


@app.post("/api/sessions/{session_id}/challenges/{challenge_id}/submit")
def submit(session_id: str, challenge_id: str, body: SubmitBody, contest_id: str | None = None) -> Any:
    return to_plain(client_from_meta(session_id).submit_flag(challenge_id, body.flag, contest_id=contest_id))


@app.get("/api/sessions/{session_id}/scoreboard")
def scoreboard(session_id: str, contest_id: str | None = None) -> Any:
    return to_plain(client_from_meta(session_id).scoreboard(contest_id=contest_id))


def main() -> None:
    import uvicorn

    host = os.environ.get("CTF_PLATFORM_HOST", "127.0.0.1")
    port = int(os.environ.get("CTF_PLATFORM_PORT", "8000"))
    uvicorn.run("ctf_platforms.server:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()

from __future__ import annotations

from typing import Any

from ..base import CTFPlatformClient
from ..models import Credentials, PlatformConfig, to_plain
from ..registry import register_platform


@register_platform("ctfdv1")
class CTFdPlatform(CTFPlatformClient):
    platform = "ctfd"
    display_name = "CTFd"

    def __init__(self, config: PlatformConfig):
        super().__init__(config)
        if not config.base_url:
            raise ValueError("CTFd requires config.base_url")
        from ..vendor.ctfd_client import CTFdClient
        self._client_cls = CTFdClient
        self.client = self._client_cls(config.base_url, timeout=config.timeout, verify=config.verify, debug=config.debug)
        self._token: str | None = None
        if config.token:
            self._apply_token(config.token)

    def _apply_token(self, token: str) -> dict[str, Any]:
        # CTFd API tokens conventionally use "Authorization: Token <token>".
        value = token if token.lower().startswith(("token ", "bearer ")) else f"Token {token}"
        self._token = token
        self.client.session.headers["Authorization"] = value
        return {"success": True, "method": "token", "header": "Authorization"}

    def _session_path(self, path: str | None = None) -> str:
        return path or self.config.session_file or str(self._client_cls.default_session_file(self.config.base_url))

    def probe(self) -> dict[str, Any]:
        return to_plain(self.client.probe())

    def login(self, credentials: Credentials) -> dict[str, Any]:
        if credentials.token:
            result = self._apply_token(credentials.token)
            saved = self.save_session(self._session_path())
            return to_plain({"login": result, "session_cache": saved})
        username, password = credentials.require_password()
        result = self.client.login(username, password)
        saved = self.save_session(self._session_path())
        return to_plain({"login": result, "session_cache": saved})

    def load_session(self, path: str | None = None) -> dict[str, Any]:
        session_path = self._session_path(path)
        result = self.client.load_session(session_path)
        try:
            import json
            from pathlib import Path
            token = json.loads(Path(session_path).read_text(encoding="utf-8")).get("token")
            if token:
                self._apply_token(token)
                result["token_loaded"] = True
        except Exception:
            pass
        return to_plain(result)

    def save_session(self, path: str | None = None) -> dict[str, Any]:
        session_path = self._session_path(path)
        result = self.client.save_session(session_path)
        if self._token:
            import json
            from pathlib import Path
            target = Path(session_path)
            data = json.loads(target.read_text(encoding="utf-8")) if target.exists() else {}
            data["token"] = self._token
            target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            result["token_saved"] = True
        return to_plain(result)

    def current_user(self) -> dict[str, Any]:
        return to_plain(self.client.get_me())

    def list_contests(self, page: int = 1, page_size: int = 50, search: str | None = None, public: bool | None = None) -> Any:
        raise self.unsupported("list_contests", "standard CTFd exposes a single challenge board")

    def get_contest(self, contest_id: str | int) -> Any:
        raise self.unsupported("get_contest", "standard CTFd has no contest object")

    def join_contest(self, contest_id: str | int, team_id: str | int | None = None, invite_code: str | None = None) -> Any:
        raise self.unsupported("join_contest", "standard CTFd has no join endpoint")

    def list_challenges(self, contest_id: str | int | None = None, page: int = 1, page_size: int = 50, search: str | None = None) -> Any:
        challenges = self.client.list_challenges()
        if search:
            needle = search.lower()
            challenges = [c for c in challenges if needle in str(c.get("name", "")).lower() or needle in str(c.get("category", "")).lower()]
        start = max(page - 1, 0) * page_size
        return to_plain(challenges[start:start + page_size])

    def get_challenge(self, challenge_id: str | int, contest_id: str | int | None = None) -> Any:
        return to_plain(self.client.get_challenge(int(challenge_id)))

    def download_attachment(self, challenge_id: str | int, outdir: str, contest_id: str | int | None = None) -> list[Any]:
        return to_plain(self.client.download_challenge_files(int(challenge_id), outdir))

    def submit_flag(self, challenge_id: str | int, flag: str, contest_id: str | int | None = None) -> Any:
        return to_plain(self.client.submit_flag(int(challenge_id), flag))

    def scoreboard(self, contest_id: str | int | None = None) -> Any:
        return to_plain(self.client.get_scoreboard())

    def raw_client(self) -> Any:
        return self.client

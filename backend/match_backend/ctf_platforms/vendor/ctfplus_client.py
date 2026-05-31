#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import requests

MAIN_ORIGIN = "https://www.ctfplus.cn"
MAIN_API = f"{MAIN_ORIGIN}/api"
TIMEOUT = 20
UA = "ctf-platform-manager-ctfplus/0.1"
SESSION_DIR = Path(".sessions")


class ApiError(RuntimeError):
    pass


@dataclass
class ExtractedFile:
    name: str
    url: str
    source: str
    extra: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "url": self.url,
            "source": self.source,
            "extra": self.extra,
        }


class JsonPrinter:
    @staticmethod
    def print(data: Any) -> None:
        print(json.dumps(data, ensure_ascii=False, indent=2))


class BaseClient:
    def __init__(self, origin: str, api_base: str, session: Optional[requests.Session] = None):
        self.origin = origin.rstrip("/")
        self.api_base = api_base.rstrip("/")
        self.s = session or requests.Session()
        self.s.headers.setdefault("User-Agent", UA)

    def _url(self, path: str) -> str:
        if path.startswith(("http://", "https://")):
            return path
        path = "/" + path.lstrip("/")
        return f"{self.api_base}{path}"

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        data: Any = None,
        expected_wrapped: bool = True,
        timeout: int = TIMEOUT,
    ) -> Any:
        url = self._url(path)
        resp = self.s.request(method.upper(), url, params=params, json=json_body, data=data, timeout=timeout)
        text = resp.text

        if expected_wrapped:
            if resp.status_code != 200:
                raise ApiError(f"{method.upper()} {url} -> HTTP {resp.status_code}: {text[:300]}")
            try:
                payload = resp.json()
            except Exception as exc:
                raise ApiError(f"{method.upper()} {url} 返回非 JSON: {text[:300]}") from exc
            code = payload.get("code", 200)
            if code != 200:
                msg = payload.get("msg") or payload.get("message") or payload.get("data") or payload
                raise ApiError(f"{method.upper()} {url} -> code={code}: {msg}")
            return payload.get("data")

        return resp


def ensure_dir(path: str) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def host_slug(url_or_host: str) -> str:
    parsed = urlparse(url_or_host)
    host = parsed.netloc or parsed.path or url_or_host
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", host)


def normalize_main_file_url(value: str) -> str:
    s = (value or "").strip()
    if not s:
        return ""
    if s.startswith(("http://", "https://", "data:", "blob:")):
        return s
    if s.startswith("/api/file/"):
        return urljoin(MAIN_ORIGIN, s)
    if s.startswith("/file/"):
        return urljoin(MAIN_ORIGIN, "/api" + s)
    s = re.sub(r"^(?:/file/)+", "", s)
    return urljoin(MAIN_ORIGIN, "/api/file/" + s.lstrip("/"))


def normalize_play_file_url(base_origin: str, value: str) -> str:
    s = (value or "").strip()
    if not s:
        return ""
    if s.startswith(("http://", "https://", "data:", "blob:")) or "http" in s:
        return s
    cleaned = re.sub(r"file|api|/", "", s)
    return urljoin(base_origin, "/api/file/" + cleaned)


def tiptap_to_text(node: Any) -> str:
    pieces: List[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            t = x.get("type")
            if t == "hardBreak":
                pieces.append("\n")
            if "text" in x and isinstance(x["text"], str):
                pieces.append(x["text"])
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for item in x:
                walk(item)

    walk(node)
    text = "".join(pieces)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _guess_file_name(url: str, fallback: str = "attachment") -> str:
    if not url:
        return fallback
    name = url.rstrip("/").split("/")[-1]
    name = name.split("?")[0].split("#")[0]
    return name or fallback


def extract_files_from_rich_content(
    obj: Any,
    *,
    source: str,
    normalizer,
) -> List[ExtractedFile]:
    out: List[ExtractedFile] = []
    seen: set[Tuple[str, str]] = set()

    def add(name: Optional[str], url: Optional[str], extra: Optional[Dict[str, Any]] = None) -> None:
        norm = normalizer(url or "")
        if not norm:
            return
        filename = (name or "").strip() or _guess_file_name(norm)
        key = (filename, norm)
        if key in seen:
            return
        seen.add(key)
        out.append(ExtractedFile(name=filename, url=norm, source=source, extra=extra or {}))

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            typ = x.get("type")
            attrs = x.get("attrs") if isinstance(x.get("attrs"), dict) else {}
            if isinstance(attrs, dict) and typ in {"fileBlock", "pdfBlock", "image", "file", "pdf", "img"}:
                add(
                    attrs.get("filename") or attrs.get("title") or attrs.get("name"),
                    attrs.get("url") or attrs.get("src") or attrs.get("file_url"),
                    {"node_type": typ},
                )
            if "attachment_path" in x:
                add(x.get("attachment_name") or x.get("name"), x.get("attachment_path"), {"node_type": typ or "attachment"})
            if "file_url" in x:
                add(x.get("attachment_name") or x.get("filename") or x.get("name"), x.get("file_url"), {"node_type": typ or "file_url"})
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for item in x:
                walk(item)

    walk(obj)
    return out


def safe_filename(name: str) -> str:
    name = name.strip() or "attachment"
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", name)
    return name[:180]


def parse_cookie_header(cookie_header: str) -> Dict[str, str]:
    cookies: Dict[str, str] = {}
    for part in cookie_header.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        key, value = part.split("=", 1)
        cookies[key.strip()] = value.strip()
    return cookies


class CTFPlusMainClient(BaseClient):
    def __init__(self) -> None:
        super().__init__(MAIN_ORIGIN, MAIN_API)
        self.main_token: Optional[str] = None

    @staticmethod
    def default_session_file() -> Path:
        return SESSION_DIR / f"ctfplus_main_{host_slug(MAIN_ORIGIN)}.json"

    def save_session(self, path: str, account: Optional[str] = None) -> Dict[str, Any]:
        if not self.main_token:
            raise ApiError("当前没有可保存的主站 token")
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "base_url": self.origin,
            "token": self.main_token,
            "account": account,
            "cookies": self.s.cookies.get_dict(),
        }
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"saved": True, "path": str(target)}

    def load_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        if not target.exists():
            return {"loaded": False, "path": str(target), "reason": "missing"}
        payload = json.loads(target.read_text(encoding="utf-8"))
        token = payload.get("token")
        if token:
            self.main_token = token
            self.s.headers["Authorization"] = token
        for key, value in (payload.get("cookies") or {}).items():
            self.s.cookies.set(key, value)
        return {
            "loaded": bool(token),
            "path": str(target),
            "account": payload.get("account"),
            "has_token": bool(token),
            "cookies": list(self.s.cookies.get_dict().keys()),
        }

    def login(self, account: str, password: str) -> Dict[str, Any]:
        data = self._request("POST", "/user/userLogin", json_body={"account": account, "passWord": password})
        token = data.get("token")
        if not token:
            raise ApiError("登录成功但未返回 token")
        self.main_token = token
        self.s.headers["Authorization"] = token
        return data

    def get_me(self) -> Dict[str, Any]:
        return self._request("GET", "/user/getMe")

    def list_joined_competitions(self, page: int = 1, size: int = 100) -> Dict[str, Any]:
        return self._request("POST", "/competition/getUserCompetitionRecord", json_body={"page": page, "size": size})

    def get_competition_detail(self, competition_id: str) -> Dict[str, Any]:
        return self._request("POST", "/competition/getCompetitionDetail", json_body={"competitionId": str(competition_id)})

    def generate_tmp_login_token(self) -> str:
        data = self._request("POST", "/user/generateTmpLoginVerifyToken")
        token = data.get("token")
        if not token:
            raise ApiError("未拿到临时登录 token")
        return token

    def check_tmp_login_token(self, tmp_token: str, auth_type: int = 1) -> Dict[str, Any]:
        resp = self._request(
            "POST",
            "/user/checkTmpLoginVerifyToken",
            json_body={"token": tmp_token, "authType": auth_type},
            expected_wrapped=False,
        )
        if resp.status_code != 200:
            raise ApiError(f"checkTmpLoginVerifyToken -> HTTP {resp.status_code}: {resp.text[:300]}")
        try:
            payload = resp.json()
        except Exception as exc:
            raise ApiError(f"checkTmpLoginVerifyToken 返回非 JSON: {resp.text[:300]}") from exc
        code = payload.get("code", 200)
        if code != 200:
            msg = payload.get("msg") or payload.get("message") or payload
            raise ApiError(f"checkTmpLoginVerifyToken -> code={code}: {msg}")
        return payload.get("data") or {}

    def probe_tmp_login_token(self, tmp_token: str, auth_type: int = 1) -> Dict[str, Any]:
        resp = self._request(
            "POST",
            "/user/checkTmpLoginVerifyToken",
            json_body={"token": tmp_token, "authType": auth_type},
            expected_wrapped=False,
        )
        out: Dict[str, Any] = {
            "http_status": resp.status_code,
            "content_type": resp.headers.get("content-type"),
            "body_preview": resp.text[:300],
        }
        try:
            out["json"] = resp.json()
        except Exception:
            pass
        return out

    def all_joined_competitions(self) -> List[Dict[str, Any]]:
        data = self.list_joined_competitions(page=1, size=200)
        return data.get("competitions") or []

    def resolve_competition(self, key: str) -> Dict[str, Any]:
        comps = self.all_joined_competitions()
        if not comps:
            raise ApiError("当前账号没有已报名比赛")

        exact = []
        fuzzy = []
        low = key.lower()
        for comp in comps:
            cid = str(comp.get("id", ""))
            short_name = str(comp.get("shortName", ""))
            name = str(comp.get("name", ""))
            fields = [cid, short_name, name]
            if key in fields:
                exact.append(comp)
            elif any(low in f.lower() for f in fields if f):
                fuzzy.append(comp)

        candidates = exact or fuzzy
        if not candidates:
            raise ApiError(f"找不到比赛: {key}")
        if len(candidates) > 1:
            raise ApiError(
                "匹配到多个比赛，请改用更精确的 competition_id/shortName/name: "
                + ", ".join(f"{c['id']}:{c.get('shortName') or c.get('name')}" for c in candidates)
            )
        return candidates[0]

    def competition_overview(self, key: str) -> Dict[str, Any]:
        comp = self.resolve_competition(key)
        detail = self.get_competition_detail(comp["id"])
        competition = detail.get("competition") or {}
        description_raw = competition.get("description")
        text = ""
        attachments: List[ExtractedFile] = []
        if isinstance(description_raw, str) and description_raw.strip().startswith("{"):
            try:
                description_json = json.loads(description_raw)
                text = tiptap_to_text(description_json)
                attachments = extract_files_from_rich_content(
                    description_json,
                    source="competition.description",
                    normalizer=normalize_main_file_url,
                )
            except Exception:
                text = description_raw
        else:
            text = description_raw or ""
        return {
            "summary": comp,
            "detail": detail,
            "description_text": text,
            "description_attachments": [x.as_dict() for x in attachments],
        }


class CTFPlusPlayClient(BaseClient):
    def __init__(self, play_origin: str) -> None:
        origin = play_origin.rstrip("/")
        super().__init__(origin, origin + "/api")
        self.play_origin = origin

    @staticmethod
    def default_session_file(play_origin: str) -> Path:
        return SESSION_DIR / f"ctfplus_play_{host_slug(play_origin)}.json"

    def save_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "base_url": self.play_origin,
            "cookies": self.s.cookies.get_dict(),
        }
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"saved": True, "path": str(target), "cookies": list(payload["cookies"].keys())}

    def load_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        if not target.exists():
            return {"loaded": False, "path": str(target), "reason": "missing"}
        payload = json.loads(target.read_text(encoding="utf-8"))
        for key, value in (payload.get("cookies") or {}).items():
            self.s.cookies.set(key, value)
        return {"loaded": True, "path": str(target), "cookies": list(self.s.cookies.get_dict().keys())}

    def set_cookie_header(self, cookie_header: str) -> Dict[str, Any]:
        parsed = parse_cookie_header(cookie_header)
        for key, value in parsed.items():
            self.s.cookies.set(key, value)
        return {"loaded": bool(parsed), "cookies": list(parsed.keys())}

    def bootstrap_with_tmp_token(
        self,
        tmp_token: str,
        *,
        verifier=None,
    ) -> Dict[str, Any]:
        resp = self._request(
            "GET",
            "/user/getBase",
            params={"token": tmp_token},
            expected_wrapped=False,
        )
        if resp.status_code == 200:
            try:
                payload = resp.json()
            except Exception as exc:
                raise ApiError(f"Play 节点引导返回非 JSON: {resp.text[:300]}") from exc
            code = payload.get("code", 200)
            if code != 200:
                raise ApiError(f"Play 节点引导失败 code={code}: {payload.get('msg') or payload}")
            return self.get_base()

        body_preview = resp.text[:300]
        if verifier and resp.status_code == 401 and "invalid character '<'" in body_preview:
            diag = verifier(tmp_token)
            diag_json = diag.get("json") if isinstance(diag, dict) else None
            if isinstance(diag_json, dict) and diag_json.get("code") == 200:
                raise ApiError(
                    "Play 节点引导失败：节点侧临时 token 回源校验存在服务端问题。"
                    f" getBase -> HTTP {resp.status_code}: {body_preview}."
                    " 但主站隐藏接口 checkTmpLoginVerifyToken 已确认该 tmp token 有效。"
                    " 这通常意味着节点服务端把回源校验请求打成了错误的方法（当前环境实测为 GET 命中 HTML 404）。"
                    " 若你已有浏览器中的有效比赛节点 cookie，可改用 --play-session-file 或 --play-cookie 继续使用题目/flag 功能。"
                )
        raise ApiError(f"Play 节点引导失败: {resp.request.method} {resp.url} -> HTTP {resp.status_code}: {body_preview}")

    def get_base(self) -> Dict[str, Any]:
        return self._request("GET", "/user/getBase")

    def list_notices(self, page: int = 1, size: int = 20, after_notice_id: int = 0) -> Dict[str, Any]:
        return self._request(
            "POST",
            "/information/getNoticeInfo",
            json_body={"after_notice_id": after_notice_id, "pages": {"page": page, "size": size}},
        )

    def all_notices(self, size: int = 20, limit_pages: int = 50) -> List[Dict[str, Any]]:
        notices: List[Dict[str, Any]] = []
        total = None
        for page in range(1, limit_pages + 1):
            data = self.list_notices(page=page, size=size, after_notice_id=0)
            part = data.get("notices") or []
            notices.extend(part)
            total = data.get("total", total)
            if not part or len(part) < size:
                break
            if total is not None and len(notices) >= int(total):
                break
        return notices

    def list_challenges(self, tags: Optional[List[str]] = None, challenge_type: Optional[int] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        if tags is not None:
            payload["tags"] = tags
        if challenge_type is not None:
            payload["type"] = challenge_type
        return self._request("POST", "/challenge/getChallengeList", json_body=payload)

    def get_challenge_detail(self, challenge_id: str) -> Dict[str, Any]:
        data = self._request("POST", "/challenge/getChallengeDetailInfo", json_body={"id": str(challenge_id)})
        return data.get("challenge") or data

    def submit_flag(self, challenge_id: str, flag: str, sub_challenge_id: Optional[str] = None) -> Dict[str, Any]:
        if sub_challenge_id:
            return self._request(
                "POST",
                "/challenge/submitSubChallengeFlag",
                json_body={
                    "challenge_id": int(challenge_id),
                    "sub_challenge_id": int(sub_challenge_id),
                    "flag": flag,
                },
            )
        return self._request(
            "POST",
            "/challenge/submitFlag",
            json_body={"challenge_id": int(challenge_id), "flag": flag},
        )

    def notice_view(self, notice: Dict[str, Any]) -> Dict[str, Any]:
        raw = notice.get("notice_content")
        text = raw or ""
        files: List[ExtractedFile] = []
        if isinstance(raw, str) and raw.strip().startswith("{"):
            try:
                parsed = json.loads(raw)
                text = tiptap_to_text(parsed)
                files = extract_files_from_rich_content(
                    parsed,
                    source=f"notice:{notice.get('notice_id')}",
                    normalizer=lambda s: normalize_play_file_url(self.play_origin, s),
                )
            except Exception:
                pass
        return {
            **notice,
            "notice_text": text,
            "attachments": [x.as_dict() for x in files],
        }

    def challenge_view(self, detail: Dict[str, Any]) -> Dict[str, Any]:
        attachments = []
        for item in detail.get("attachments") or []:
            attachments.append(
                ExtractedFile(
                    name=item.get("attachment_name") or _guess_file_name(item.get("attachment_path") or "attachment"),
                    url=normalize_play_file_url(self.play_origin, item.get("attachment_path") or ""),
                    source=f"challenge:{detail.get('challenge_id')}",
                    extra=item,
                ).as_dict()
            )
        short_desc = detail.get("short_des")
        short_desc_text = short_desc or ""
        if isinstance(short_desc, str) and short_desc.strip().startswith("{"):
            try:
                short_desc_text = tiptap_to_text(json.loads(short_desc))
            except Exception:
                pass
        return {
            **detail,
            "short_des_text": short_desc_text,
            "attachments_normalized": attachments,
        }


def download_file(session: requests.Session, url: str, dest: Path) -> Path:
    with session.get(url, stream=True, timeout=TIMEOUT) as resp:
        if resp.status_code != 200:
            raise ApiError(f"下载失败 {url} -> HTTP {resp.status_code}: {resp.text[:200]}")
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
    return dest


def prepare_play_client(
    args: argparse.Namespace,
    main_client: CTFPlusMainClient,
    competition_key: str,
) -> Tuple[Dict[str, Any], CTFPlusPlayClient, str, str]:
    overview = main_client.competition_overview(competition_key)
    competition = overview["detail"].get("competition") or {}
    address = (competition.get("address") or "").strip()
    if not address:
        raise ApiError("该比赛没有配置 play 节点地址，无法通过比赛节点 API 获取公告/题目/提交 flag")

    play_session_file = args.play_session_file or str(CTFPlusPlayClient.default_session_file(address))

    # 1) try manually supplied / cached play session first
    if args.play_cookie or Path(play_session_file).exists():
        play = CTFPlusPlayClient(address)
        loaded: Dict[str, Any] = {"manual_cookie": False, "session_file": None}
        if args.play_cookie:
            loaded["manual_cookie"] = bool(play.set_cookie_header(args.play_cookie).get("loaded"))
        if Path(play_session_file).exists():
            loaded["session_file"] = play.load_session(play_session_file)
        try:
            play.get_base()
            return overview, play, play_session_file, "reused_play_session"
        except Exception:
            pass

    # 2) fallback to tmp token bootstrap
    tmp_token = main_client.generate_tmp_login_token()
    play = CTFPlusPlayClient(address)
    play.bootstrap_with_tmp_token(tmp_token, verifier=lambda token: main_client.probe_tmp_login_token(token, auth_type=1))
    play.save_session(play_session_file)
    return overview, play, play_session_file, "tmp_bootstrap"


def cmd_login(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    if not args.account or not args.password:
        raise ApiError("login 命令需要 --account / --password，或设置 CTFPLUS_ACCOUNT / CTFPLUS_PASSWORD")
    login_data = main.login(args.account, args.password)
    saved = main.save_session(args.session_file, account=args.account)
    JsonPrinter.print({
        "login": login_data,
        "me": main.get_me(),
        "session_cache": saved,
    })


def cmd_session(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    JsonPrinter.print({
        "session_file": args.session_file,
        "has_authorization": bool(main.main_token or main.s.headers.get("Authorization")),
        "cookies": main.s.cookies.get_dict(),
    })


def cmd_me(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    JsonPrinter.print(main.get_me())


def cmd_competitions(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    JsonPrinter.print(main.list_joined_competitions(page=args.page, size=args.size))


def cmd_competition_detail(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    JsonPrinter.print(main.competition_overview(args.competition))


def cmd_competition_description_files(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    data = main.competition_overview(args.competition)
    files = data.get("description_attachments") or []
    if args.download:
        outdir = ensure_dir(args.output)
        downloaded = []
        for item in files:
            name = safe_filename(item["name"])
            path = outdir / name
            download_file(main.s, item["url"], path)
            downloaded.append({**item, "saved_to": str(path)})
        JsonPrinter.print({"competition": data["summary"], "downloaded": downloaded})
        return
    JsonPrinter.print({"competition": data["summary"], "description_attachments": files})


def cmd_probe_play_auth(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    overview = main.competition_overview(args.competition)
    competition = overview["detail"].get("competition") or {}
    address = (competition.get("address") or "").strip()
    if not address:
        raise ApiError("该比赛没有配置 play 节点地址")

    tmp_token = main.generate_tmp_login_token()
    hidden = main.probe_tmp_login_token(tmp_token, auth_type=1)
    play = CTFPlusPlayClient(address)
    raw = play._request("GET", "/user/getBase", params={"token": tmp_token}, expected_wrapped=False)

    diagnosis = "unknown"
    if raw.status_code == 401 and "invalid character '<'" in raw.text and isinstance(hidden.get("json"), dict) and hidden["json"].get("code") == 200:
        diagnosis = "node_upstream_tmp_validation_bug"
    elif raw.status_code == 200:
        diagnosis = "ok"

    JsonPrinter.print({
        "competition": overview["summary"],
        "play_origin": address,
        "hidden_check": hidden,
        "play_get_base": {
            "http_status": raw.status_code,
            "content_type": raw.headers.get("content-type"),
            "body_preview": raw.text[:300],
        },
        "diagnosis": diagnosis,
        "hint": (
            "若 diagnosis 为 node_upstream_tmp_validation_bug，说明 tmp token 在主站校验接口有效，但比赛节点自身回源校验流程有服务端问题；"
            "此时可等待节点修复，或手工提供已登录浏览器中的比赛节点 cookie 给 --play-cookie / --play-session-file。"
        ),
    })


def cmd_notices(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    overview, play, play_session_file, auth_mode = prepare_play_client(args, main, args.competition)
    notices = [play.notice_view(n) for n in play.all_notices(size=args.size)]
    JsonPrinter.print({
        "competition": overview["summary"],
        "play_origin": play.play_origin,
        "play_session_file": play_session_file,
        "auth_mode": auth_mode,
        "notices": notices,
    })


def cmd_download_notice_attachments(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    overview, play, play_session_file, auth_mode = prepare_play_client(args, main, args.competition)
    notices = [play.notice_view(n) for n in play.all_notices(size=args.size)]
    if args.notice_id:
        notices = [n for n in notices if str(n.get("notice_id")) == str(args.notice_id)]
        if not notices:
            raise ApiError(f"找不到 notice_id={args.notice_id}")
    outdir = ensure_dir(args.output)
    downloaded = []
    for notice in notices:
        ndir = outdir / f"notice_{notice.get('notice_id')}"
        ndir.mkdir(parents=True, exist_ok=True)
        for item in notice.get("attachments") or []:
            path = ndir / safe_filename(item["name"])
            download_file(play.s, item["url"], path)
            downloaded.append({
                "notice_id": notice.get("notice_id"),
                "notice_title": notice.get("notice_title"),
                **item,
                "saved_to": str(path),
            })
    JsonPrinter.print({
        "competition": overview["summary"],
        "play_origin": play.play_origin,
        "play_session_file": play_session_file,
        "auth_mode": auth_mode,
        "downloaded": downloaded,
    })


def cmd_challenges(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    overview, play, play_session_file, auth_mode = prepare_play_client(args, main, args.competition)
    tags = args.tags if args.tags else None
    data = play.list_challenges(tags=tags, challenge_type=args.challenge_type)
    JsonPrinter.print({
        "competition": overview["summary"],
        "play_origin": play.play_origin,
        "play_session_file": play_session_file,
        "auth_mode": auth_mode,
        "tags": tags,
        "challenge_type": args.challenge_type,
        "result": data,
    })


def cmd_challenge_detail(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    overview, play, play_session_file, auth_mode = prepare_play_client(args, main, args.competition)
    detail = play.challenge_view(play.get_challenge_detail(args.challenge_id))
    JsonPrinter.print({
        "competition": overview["summary"],
        "play_origin": play.play_origin,
        "play_session_file": play_session_file,
        "auth_mode": auth_mode,
        "challenge": detail,
    })


def cmd_submit_flag(args: argparse.Namespace, main: CTFPlusMainClient) -> None:
    overview, play, play_session_file, auth_mode = prepare_play_client(args, main, args.competition)
    result = play.submit_flag(args.challenge_id, args.flag, sub_challenge_id=args.sub_challenge_id)
    JsonPrinter.print({
        "competition": overview["summary"],
        "play_origin": play.play_origin,
        "play_session_file": play_session_file,
        "auth_mode": auth_mode,
        "submit_result": result,
    })



def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CTFPlus main/play API CLI")
    parser.add_argument("--account", default=os.environ.get("CTFPLUS_ACCOUNT"), help="CTFPlus 账号；默认读取 CTFPLUS_ACCOUNT")
    parser.add_argument("--password", default=os.environ.get("CTFPLUS_PASSWORD"), help="CTFPlus 密码；默认读取 CTFPLUS_PASSWORD")
    parser.add_argument("--session-file", default=str(CTFPlusMainClient.default_session_file()), help="主站会话缓存文件")
    parser.add_argument("--play-session-file", help="比赛节点 cookies 缓存文件；默认自动使用 .sessions/ctfplus_play_<host>.json")
    parser.add_argument("--play-cookie", help="手工提供比赛节点 cookie，格式如 'name=value; other=value'")

    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("login", help="登录并写入主站会话缓存")
    p.set_defaults(func=cmd_login)

    p = sub.add_parser("session", help="查看当前主站会话状态")
    p.set_defaults(func=cmd_session)

    p = sub.add_parser("me", help="获取当前账号信息")
    p.set_defaults(func=cmd_me)

    p = sub.add_parser("competitions", help="获取已报名比赛列表")
    p.add_argument("--page", type=int, default=1)
    p.add_argument("--size", type=int, default=100)
    p.set_defaults(func=cmd_competitions)

    p = sub.add_parser("competition-detail", help="获取比赛详情（主站）")
    p.add_argument("competition", help="competition_id / shortName / name")
    p.set_defaults(func=cmd_competition_detail)

    p = sub.add_parser("competition-description-files", help="提取比赛详情页 description 内嵌附件")
    p.add_argument("competition", help="competition_id / shortName / name")
    p.add_argument("--download", action="store_true", help="直接下载")
    p.add_argument("--output", default="downloads/ctfplus/competition_description_files")
    p.set_defaults(func=cmd_competition_description_files)

    p = sub.add_parser("probe-play-auth", help="诊断比赛节点 tmp token 引导链路")
    p.add_argument("competition", help="competition_id / shortName / name")
    p.set_defaults(func=cmd_probe_play_auth)

    p = sub.add_parser("notices", help="获取比赛节点公告列表")
    p.add_argument("competition", help="competition_id / shortName / name")
    p.add_argument("--size", type=int, default=20)
    p.set_defaults(func=cmd_notices)

    p = sub.add_parser("download-notice-attachments", help="下载比赛节点公告中的附件")
    p.add_argument("competition", help="competition_id / shortName / name")
    p.add_argument("--notice-id", help="只下载指定公告")
    p.add_argument("--size", type=int, default=20)
    p.add_argument("--output", default="downloads/ctfplus/notice_attachments")
    p.set_defaults(func=cmd_download_notice_attachments)

    p = sub.add_parser("challenges", help="获取比赛节点题目列表")
    p.add_argument("competition", help="competition_id / shortName / name")
    p.add_argument("--tags", nargs="*", default=None, help="标签数组，例如 Web Misc")
    p.add_argument("--challenge-type", type=int, default=None, help="题型过滤，scene 页面在前端会传 4")
    p.set_defaults(func=cmd_challenges)

    p = sub.add_parser("challenge-detail", help="获取比赛节点题目详情")
    p.add_argument("competition", help="competition_id / shortName / name")
    p.add_argument("challenge_id")
    p.set_defaults(func=cmd_challenge_detail)

    p = sub.add_parser("submit-flag", help="提交 flag")
    p.add_argument("competition", help="competition_id / shortName / name")
    p.add_argument("challenge_id")
    p.add_argument("flag")
    p.add_argument("--sub-challenge-id", help="子题 ID；存在子题时调用 submitSubChallengeFlag")
    p.set_defaults(func=cmd_submit_flag)

    return parser



def ensure_main_auth(args: argparse.Namespace, main_client: CTFPlusMainClient) -> None:
    if args.cmd == "login":
        return
    if args.account and args.password:
        main_client.login(args.account, args.password)
        main_client.save_session(args.session_file, account=args.account)
        return
    load_result = main_client.load_session(args.session_file)
    if not load_result.get("loaded"):
        raise ApiError(
            "缺少账号或密码，且未找到可用主站会话：请先运行 login，或传 --account / --password，"
            f"当前 session-file={args.session_file}"
        )



def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        main_client = CTFPlusMainClient()
        if args.cmd == "login":
            args.func(args, main_client)
        else:
            ensure_main_auth(args, main_client)
            args.func(args, main_client)
        return 0
    except ApiError as exc:
        print(f"[!] {exc}", file=sys.stderr)
        return 1
    except requests.RequestException as exc:
        print(f"[!] 网络错误: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

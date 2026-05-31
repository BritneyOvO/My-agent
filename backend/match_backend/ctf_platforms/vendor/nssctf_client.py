#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, unquote, urlparse

import requests

DEFAULT_TIMEOUT = 20
UA = "ctf-platform-manager-nssctf/0.1"
SESSION_DIR = Path(".sessions")


class NSSCTFError(RuntimeError):
    pass


@dataclass
class DownloadedFile:
    url: str
    path: str
    size: int
    content_type: str


class NSSCTFClient:
    def __init__(self, base_url: str, timeout: int = DEFAULT_TIMEOUT, verify: bool = True, debug: bool = False):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.verify = verify
        self.debug = debug
        self.session = requests.Session()
        self.session.verify = verify
        self.session.headers.update(
            {
                "User-Agent": UA,
                "Accept": "application/json, text/plain, */*",
                "Content-Type": "application/json",
                "Referer": self.base_url + "/user/login?redirect=/index",
                "Origin": self.base_url,
            }
        )

    @staticmethod
    def default_session_file(base_url: str) -> Path:
        host = base_url.split("://", 1)[-1].replace("/", "_").replace(":", "_")
        return SESSION_DIR / f"nssctf_{host}.json"

    def log(self, *parts: Any) -> None:
        if self.debug:
            print("[DEBUG]", *parts, file=sys.stderr)

    def _url(self, path_or_url: str) -> str:
        if path_or_url.startswith(("http://", "https://")):
            return path_or_url
        if not path_or_url.startswith("/"):
            path_or_url = "/" + path_or_url
        return self.base_url + path_or_url

    def _request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        url = self._url(path)
        kwargs.setdefault("timeout", self.timeout)
        resp = self.session.request(method, url, **kwargs)
        self.log(method, url, "->", resp.status_code, resp.headers.get("content-type", ""))
        return resp

    def _json(self, resp: requests.Response) -> Any:
        try:
            return resp.json()
        except Exception as exc:
            raise NSSCTFError(f"Expected JSON from {resp.url}, got: {resp.text[:200]!r}") from exc

    def _unwrap(self, resp: requests.Response, allow_login_required: bool = False) -> Dict[str, Any]:
        data = self._json(resp)
        if not isinstance(data, dict):
            raise NSSCTFError(f"Unexpected response shape from {resp.url}: {data!r}")
        code = data.get("code")
        if code == 200:
            return data
        if allow_login_required and code == 402:
            return data
        raise NSSCTFError(f"API error code={code}: {data}")

    @staticmethod
    def explain_code(code: Any) -> str:
        mapping = {
            200: "成功",
            204: "提交未通过，通常表示 flag 错误、题目未开放，或当前状态不允许提交",
            301: "需要进一步认证/权限不足",
            402: "需要登录",
        }
        return mapping.get(code, f"未识别状态码 {code}")

    def save_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "base_url": self.base_url,
            "cookies": self.session.cookies.get_dict(),
        }
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"saved": True, "path": str(target), "cookies": list(data["cookies"].keys())}

    def load_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        if not target.exists():
            return {"loaded": False, "path": str(target), "reason": "missing"}
        data = json.loads(target.read_text(encoding="utf-8"))
        for key, value in (data.get("cookies") or {}).items():
            self.session.cookies.set(key, value)
        return {"loaded": True, "path": str(target), "cookies": list(self.session.cookies.get_dict().keys())}

    def probe(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"base_url": self.base_url}
        checks = [
            ("GET", "/user/login?redirect=/index", None),
            ("GET", "/api/user/info/", None),
            ("POST", "/api/contest/list/1/", {}),
            ("GET", "/api/contest/collection/list/", None),
        ]
        for method, path, payload in checks:
            try:
                if method == "GET":
                    r = self._request("GET", path)
                else:
                    r = self._request("POST", path, json=payload)
                item = {"status": r.status_code, "content_type": r.headers.get("content-type", "")}
                if "json" in item["content_type"]:
                    item["body"] = self._json(r)
                else:
                    item["body_preview"] = r.text[:200]
                out[path] = item
            except Exception as exc:
                out[path] = {"error": str(exc)}
        return out

    def login(self, username: str, password: str, remember: bool = True) -> Dict[str, Any]:
        payload = {"username": username, "password": password, "remember": "1" if remember else "0"}
        resp = self._request("POST", "/api/user/login/", json=payload)
        resp.raise_for_status()
        data = self._unwrap(resp)
        return {
            "success": data.get("code") == 200,
            "data": data.get("data"),
            "cookies": self.session.cookies.get_dict(),
        }

    def current_user(self) -> Dict[str, Any]:
        resp = self._request("GET", "/api/user/info/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def list_contests(self, page: int = 1, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        resp = self._request("POST", f"/api/contest/list/{page}/", json=filters or {})
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def my_contests(self, page: int = 1) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/contest/my/list/{page}/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def contest_info(self, contest_id: int) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/contest/{contest_id}/info/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def contest_accessible(self, contest_id: int) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/contest/{contest_id}/accessible/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def contest_role(self, contest_id: int) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/contest/{contest_id}/role/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def contest_register(self, contest_id: int, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        resp = self._request("POST", f"/api/contest/{contest_id}/register/", json=payload or {})
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def problem_filter_options(self) -> Dict[str, Any]:
        resp = self._request("GET", "/api/problem/filter/options/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def problem_recent(self) -> List[Dict[str, Any]]:
        resp = self._request("GET", "/api/problem/index/recent/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or []

    def problem_list(self, page: int = 1, page_size: int = 20, filters: Optional[Dict[str, Any]] = None, team_mode: bool = False) -> Dict[str, Any]:
        path = f"/api/problem/team/list/{page}/{page_size}/" if team_mode else f"/api/problem/v3/list/{page}/{page_size}/"
        resp = self._request("POST", path, json=filters or {})
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def problem_detail(self, problem_id: int) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/problem/v2/{problem_id}/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def problem_annex(self, problem_id: int) -> requests.Response:
        resp = self._request("GET", f"/api/problem/{problem_id}/annex/download/", stream=True)
        resp.raise_for_status()
        return resp

    def open_problem_attachment(self, problem_id: int, type_id: int = 0) -> Dict[str, Any]:
        """
        逆向确认的前置链路：
        1) POST /api/problem/docker/<pid>/open/ {"type":0}
        2) GET  /api/problem/<pid>/annex/download/

        某些题目如果不先走 open，annex/download 会返回 {"code":203,"data":null}。
        """
        resp = self._request("POST", f"/api/problem/docker/{problem_id}/open/", json={"type": type_id})
        resp.raise_for_status()
        data = self._json(resp)
        if not isinstance(data, dict):
            raise NSSCTFError(f"Unexpected open response from {resp.url}: {data!r}")
        return data

    @staticmethod
    def _filename_from_url(url: str) -> Optional[str]:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        for key in ("response-content-disposition", "content-disposition"):
            for value in query.get(key, []):
                if "filename=" in value:
                    return unquote(value.split("filename=", 1)[1].strip().strip('"'))
        return None

    def _resolve_problem_annex_download(self, problem_id: int) -> requests.Response:
        # 尝试补齐前置 open 步骤；失败时不立刻终止，继续探测 annex 接口返回。
        try:
            open_data = self.open_problem_attachment(problem_id)
            self.log("problem open", problem_id, "->", open_data)
        except Exception as exc:
            self.log("problem open failed", problem_id, exc)

        resp = self.problem_annex(problem_id)
        ctype = resp.headers.get("content-type", "")
        if "json" not in ctype:
            return resp

        data = self._json(resp)
        if not isinstance(data, dict):
            raise NSSCTFError(f"Unexpected annex response shape from {resp.url}: {data!r}")
        code = data.get("code")
        if code != 200:
            raise NSSCTFError(f"Problem annex unavailable code={code}: {data}")
        external_url = data.get("data")
        if not isinstance(external_url, str) or not external_url.startswith(("http://", "https://")):
            raise NSSCTFError(f"Problem annex response missing downloadable URL: {data}")
        real = self._request("GET", external_url, stream=True)
        real.raise_for_status()
        return real

    def download_problem_annex(self, problem_id: int, outdir: str, filename: Optional[str] = None) -> List[DownloadedFile]:
        resp = self._resolve_problem_annex_download(problem_id)
        out = Path(outdir)
        out.mkdir(parents=True, exist_ok=True)
        ctype = resp.headers.get("content-type", "")
        if not filename:
            cd = resp.headers.get("content-disposition", "")
            if "filename=" in cd:
                filename = cd.split("filename=", 1)[1].strip().strip('"')
            elif resp.url:
                filename = self._filename_from_url(resp.url)
            elif "json" in ctype:
                filename = f"problem_{problem_id}_annex.json"
            else:
                filename = f"problem_{problem_id}.bin"
        path = out / filename
        size = 0
        with path.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                fh.write(chunk)
                size += len(chunk)
        return [DownloadedFile(url=resp.url, path=str(path), size=size, content_type=ctype)]

    def submit_problem_flag(self, problem_id: int, flag: str) -> Dict[str, Any]:
        resp = self._request("POST", f"/api/problem/submit/{problem_id}/", json={"flag": flag})
        resp.raise_for_status()
        data = self._json(resp)
        if not isinstance(data, dict):
            raise NSSCTFError(f"Unexpected response shape from {resp.url}: {data!r}")
        code = data.get("code")
        return {
            "code": code,
            "ok": code == 200,
            "message": self.explain_code(code),
            "data": data.get("data") or {},
        }

    def contest_problem_categories(self, contest_id: int) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/contest/{contest_id}/problem/category/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def contest_problem_list(self, contest_id: int) -> Dict[str, Any]:
        """Return all visible contest problems grouped and flattened.

        NSSCTF exposes contest problem lists by category id at
        /api/contest/<cid>/problem/<type>/. The same path with a real problem id
        returns detail, so the category ids are first discovered through
        /problem/category/.
        """
        cats = self.contest_problem_categories(contest_id)
        types = cats.get("type") or []
        grouped: Dict[str, Any] = {}
        problems: List[Dict[str, Any]] = []
        for typ in types:
            resp = self._request("GET", f"/api/contest/{contest_id}/problem/{typ}/")
            resp.raise_for_status()
            data = self._unwrap(resp).get("data") or []
            grouped[str(typ)] = data
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict):
                        problems.append({**item, "contest_category": typ})
        return {"contest_id": contest_id, "categories": cats, "grouped": grouped, "problems": problems, "total": len(problems)}

    def contest_rank(self, contest_id: int, page: int = 1) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/contest/{contest_id}/rank/{page}/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def challenge_detail(self, contest_id: int, problem_id: int, team_mode: bool = False) -> Dict[str, Any]:
        path = f"/api/contest/team/{contest_id}/problem/{problem_id}/" if team_mode else f"/api/contest/{contest_id}/problem/{problem_id}/"
        resp = self._request("GET", path)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def challenge_annex(self, contest_id: int, problem_id: int) -> requests.Response:
        resp = self._request("GET", f"/api/contest/{contest_id}/problem/{problem_id}/annex/", stream=True)
        resp.raise_for_status()
        return resp

    def download_annex(self, contest_id: int, problem_id: int, outdir: str, filename: Optional[str] = None) -> List[DownloadedFile]:
        resp = self.challenge_annex(contest_id, problem_id)
        out = Path(outdir)
        out.mkdir(parents=True, exist_ok=True)
        ctype = resp.headers.get("content-type", "")
        if not filename:
            cd = resp.headers.get("content-disposition", "")
            if "filename=" in cd:
                filename = cd.split("filename=", 1)[1].strip().strip('"')
            elif "json" in ctype:
                filename = f"contest_{contest_id}_problem_{problem_id}_annex.json"
            else:
                filename = f"contest_{contest_id}_problem_{problem_id}.bin"
        path = out / filename
        size = 0
        with path.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                fh.write(chunk)
                size += len(chunk)
        return [DownloadedFile(url=resp.url, path=str(path), size=size, content_type=ctype)]

    def submit_flag(self, contest_id: int, problem_id: int, flag: str, team_mode: bool = False) -> Dict[str, Any]:
        path = f"/api/contest/team/{contest_id}/problem/{problem_id}/submit/" if team_mode else f"/api/contest/{contest_id}/problem/{problem_id}/submit/"
        resp = self._request("POST", path, json={"flag": flag})
        resp.raise_for_status()
        data = self._json(resp)
        if not isinstance(data, dict):
            raise NSSCTFError(f"Unexpected response shape from {resp.url}: {data!r}")
        code = data.get("code")
        return {
            "code": code,
            "ok": code == 200,
            "message": self.explain_code(code),
            "data": data.get("data") or {},
        }


def emit(data: Any, as_json: bool) -> None:
    if as_json or isinstance(data, (dict, list)):
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(data)


def main() -> int:
    parser = argparse.ArgumentParser(description="NSSCTF automation client")
    parser.add_argument("--base-url", default="https://www.nssctf.cn")
    parser.add_argument("--session-file", help="Session cache file. Defaults to .sessions/nssctf_<host>.json")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--insecure", action="store_true")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--json", action="store_true")

    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe")

    p = sub.add_parser("login")
    p.add_argument("--username", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--no-remember", action="store_true")

    sub.add_parser("me")
    sub.add_parser("session")

    sub.add_parser("problem-filters")
    sub.add_parser("problem-recent")

    p = sub.add_parser("problems")
    p.add_argument("--page", type=int, default=1)
    p.add_argument("--page-size", type=int, default=20)
    p.add_argument("--filters", help="Raw JSON filter body for /api/problem/v3/list/<page>/<page_size>/")
    p.add_argument("--team-mode", action="store_true")

    p = sub.add_parser("problem")
    p.add_argument("--problem-id", type=int, required=True)

    p = sub.add_parser("problem-download")
    p.add_argument("--problem-id", type=int, required=True)
    p.add_argument("--outdir", required=True)
    p.add_argument("--filename")

    p = sub.add_parser("problem-submit")
    p.add_argument("--problem-id", type=int, required=True)
    p.add_argument("--flag", required=True)

    p = sub.add_parser("contests")
    p.add_argument("--page", type=int, default=1)
    p.add_argument("--filters", help="Raw JSON filter body for /api/contest/list/<page>/")

    p = sub.add_parser("my-contests")
    p.add_argument("--page", type=int, default=1)

    p = sub.add_parser("contest")
    p.add_argument("--contest-id", type=int, required=True)

    p = sub.add_parser("contest-access")
    p.add_argument("--contest-id", type=int, required=True)

    p = sub.add_parser("contest-role")
    p.add_argument("--contest-id", type=int, required=True)

    p = sub.add_parser("contest-register")
    p.add_argument("--contest-id", type=int, required=True)
    p.add_argument("--payload", help="Raw JSON payload for contest register")

    p = sub.add_parser("challenge")
    p.add_argument("--contest-id", type=int, required=True)
    p.add_argument("--problem-id", type=int, required=True)
    p.add_argument("--team-mode", action="store_true")

    p = sub.add_parser("download")
    p.add_argument("--contest-id", type=int, required=True)
    p.add_argument("--problem-id", type=int, required=True)
    p.add_argument("--outdir", required=True)
    p.add_argument("--filename")

    p = sub.add_parser("submit")
    p.add_argument("--contest-id", type=int, required=True)
    p.add_argument("--problem-id", type=int, required=True)
    p.add_argument("--flag", required=True)
    p.add_argument("--team-mode", action="store_true")

    args = parser.parse_args()
    if not args.session_file:
        args.session_file = str(NSSCTFClient.default_session_file(args.base_url))

    client = NSSCTFClient(args.base_url, timeout=args.timeout, verify=not args.insecure, debug=args.debug)
    client.load_session(args.session_file)

    try:
        if args.cmd == "probe":
            emit(client.probe(), args.json)
        elif args.cmd == "login":
            data = client.login(args.username, args.password, remember=not args.no_remember)
            data["session"] = client.save_session(args.session_file)
            emit(data, args.json)
        elif args.cmd == "me":
            emit(client.current_user(), args.json)
        elif args.cmd == "session":
            emit({"path": args.session_file, "cookies": client.session.cookies.get_dict()}, args.json)
        elif args.cmd == "problem-filters":
            emit(client.problem_filter_options(), args.json)
        elif args.cmd == "problem-recent":
            emit(client.problem_recent(), args.json)
        elif args.cmd == "problems":
            filters = json.loads(args.filters) if args.filters else {}
            emit(client.problem_list(args.page, args.page_size, filters, args.team_mode), args.json)
        elif args.cmd == "problem":
            emit(client.problem_detail(args.problem_id), args.json)
        elif args.cmd == "problem-download":
            emit([asdict(x) for x in client.download_problem_annex(args.problem_id, args.outdir, args.filename)], args.json)
        elif args.cmd == "problem-submit":
            emit(client.submit_problem_flag(args.problem_id, args.flag), args.json)
        elif args.cmd == "contests":
            filters = json.loads(args.filters) if args.filters else {}
            emit(client.list_contests(args.page, filters), args.json)
        elif args.cmd == "my-contests":
            emit(client.my_contests(args.page), args.json)
        elif args.cmd == "contest":
            emit(client.contest_info(args.contest_id), args.json)
        elif args.cmd == "contest-access":
            emit(client.contest_accessible(args.contest_id), args.json)
        elif args.cmd == "contest-role":
            emit(client.contest_role(args.contest_id), args.json)
        elif args.cmd == "contest-register":
            payload = json.loads(args.payload) if args.payload else {}
            emit(client.contest_register(args.contest_id, payload), args.json)
        elif args.cmd == "challenge":
            emit(client.challenge_detail(args.contest_id, args.problem_id, args.team_mode), args.json)
        elif args.cmd == "download":
            emit([asdict(x) for x in client.download_annex(args.contest_id, args.problem_id, args.outdir, args.filename)], args.json)
        elif args.cmd == "submit":
            emit(client.submit_flag(args.contest_id, args.problem_id, args.flag, args.team_mode), args.json)
        else:
            parser.error("unknown command")
    except Exception as exc:
        print(f"[!] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

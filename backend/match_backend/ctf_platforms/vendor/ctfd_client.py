#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

import requests

DEFAULT_TIMEOUT = 20
UA = "ctf-platform-manager-ctfd/0.1"
SESSION_DIR = Path(".sessions")


class CTFdError(RuntimeError):
    pass


@dataclass
class DownloadedFile:
    url: str
    path: str
    size: int


class CTFdClient:
    def __init__(self, base_url: str, timeout: int = DEFAULT_TIMEOUT, verify: bool = True, debug: bool = False):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.verify = verify
        self.debug = debug
        self.session = requests.Session()
        self.session.verify = verify
        self.session.headers.update({"User-Agent": UA})
        self.csrf_nonce: Optional[str] = None

    @staticmethod
    def default_session_file(base_url: str) -> Path:
        host = base_url.split("://", 1)[-1].replace("/", "_").replace(":", "_")
        return SESSION_DIR / f"ctfd_{host}.json"

    def log(self, *parts: Any) -> None:
        if self.debug:
            print("[DEBUG]", *parts, file=sys.stderr)

    def save_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "base_url": self.base_url,
            "csrf_nonce": self.csrf_nonce,
            "cookies": self.session.cookies.get_dict(),
        }
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"saved": True, "path": str(target), "cookies": list(data["cookies"].keys())}

    def load_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        if not target.exists():
            return {"loaded": False, "path": str(target), "reason": "missing"}
        data = json.loads(target.read_text(encoding="utf-8"))
        self.csrf_nonce = data.get("csrf_nonce")
        for key, value in (data.get("cookies") or {}).items():
            self.session.cookies.set(key, value)
        return {"loaded": True, "path": str(target), "cookies": list(self.session.cookies.get_dict().keys())}

    def _url(self, path_or_url: str) -> str:
        if path_or_url.startswith(("http://", "https://")):
            return path_or_url
        if not path_or_url.startswith("/"):
            path_or_url = "/" + path_or_url
        return self.base_url + path_or_url

    def _extract_window_init(self, html: str) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        m = re.search(r"window\.init\s*=\s*\{(.*?)\}\s*</script>", html, re.S)
        if not m:
            return out
        blob = m.group(1)
        patterns = {
            "csrfNonce": r"'csrfNonce'\s*:\s*\"([^\"]*)\"",
            "userId": r"'userId'\s*:\s*([^,\n]+)",
            "userName": r"'userName'\s*:\s*(null|\"[^\"]*\")",
            "userEmail": r"'userEmail'\s*:\s*(null|\"[^\"]*\")",
        }
        for key, pat in patterns.items():
            mm = re.search(pat, blob)
            if not mm:
                continue
            val = mm.group(1).strip()
            if val == "null":
                out[key] = None
            elif val.startswith('"') and val.endswith('"'):
                out[key] = val[1:-1]
            else:
                try:
                    out[key] = int(val)
                except ValueError:
                    out[key] = val
        return out

    def _update_csrf_from_html(self, html: str) -> Optional[str]:
        init = self._extract_window_init(html)
        if init.get("csrfNonce"):
            self.csrf_nonce = init["csrfNonce"]
        return self.csrf_nonce

    def _request(self, method: str, path: str, want_json: bool = False, **kwargs: Any) -> requests.Response:
        url = self._url(path)
        kwargs.setdefault("timeout", self.timeout)
        headers = dict(kwargs.pop("headers", {}) or {})
        if want_json:
            headers.setdefault("Accept", "application/json")
            headers.setdefault("Content-Type", "application/json")
            if self.csrf_nonce:
                headers.setdefault("CSRF-Token", self.csrf_nonce)
        resp = self.session.request(method, url, headers=headers, **kwargs)
        self.log(method, url, "->", resp.status_code, resp.headers.get("content-type", ""))
        ctype = resp.headers.get("content-type", "")
        if "text/html" in ctype:
            self._update_csrf_from_html(resp.text)
        return resp

    def _json(self, resp: requests.Response) -> Any:
        try:
            return resp.json()
        except Exception as exc:
            raise CTFdError(f"Expected JSON from {resp.url}, got: {resp.text[:200]!r}") from exc

    def _ensure_json(self, resp: requests.Response) -> Any:
        ctype = resp.headers.get("content-type", "")
        if "application/json" not in ctype:
            raise CTFdError(f"Expected JSON from {resp.url}, got content-type {ctype!r}")
        return self._json(resp)

    def probe(self) -> Dict[str, Any]:
        info = {"base_url": self.base_url, "cookies": self.session.cookies.get_dict()}
        for path in ["/", "/login", "/challenges", "/api/v1/scoreboard"]:
            try:
                r = self._request("GET", path, allow_redirects=True)
                item: Dict[str, Any] = {"status": r.status_code, "content_type": r.headers.get("content-type", "")}
                if "text/html" in item["content_type"]:
                    item["init"] = self._extract_window_init(r.text)
                info[path] = item
            except Exception as exc:
                info[path] = {"error": str(exc)}
        return info

    def login(self, username: str, password: str) -> Dict[str, Any]:
        page = self._request("GET", "/login", allow_redirects=True)
        page.raise_for_status()
        html = page.text
        nonce = re.search(r'name="nonce"[^>]*value="([^"]+)"', html)
        if not nonce:
            raise CTFdError("Failed to find login nonce")
        data = {"name": username, "password": password, "nonce": nonce.group(1), "_submit": "Submit"}
        resp = self._request("POST", "/login", data=data, allow_redirects=True, headers={"Content-Type": "application/x-www-form-urlencoded"})
        resp.raise_for_status()
        final_html = resp.text
        init = self._extract_window_init(final_html)
        # success heuristics
        success = False
        if resp.url.rstrip("/").endswith("/challenges"):
            success = True
        if init.get("userId") not in (None, 0, "0"):
            success = True
        if re.search(r'href="/logout"', final_html):
            success = True
        if success:
            self._update_csrf_from_html(final_html)
            me = None
            try:
                me = self.get_me()
            except Exception:
                pass
            return {
                "success": True,
                "method": "form",
                "session": self.session.cookies.get_dict(),
                "csrf_nonce": self.csrf_nonce,
                "user": me,
                "final_url": resp.url,
            }
        errors = re.findall(r'<div[^>]*alert[^>]*>(.*?)</div>', final_html, re.S | re.I)
        cleaned = [re.sub(r"<[^>]+>", " ", e).strip() for e in errors]
        if not cleaned and "Your username or password is incorrect" in final_html:
            cleaned = ["Your username or password is incorrect"]
        raise CTFdError("Login failed" + (": " + " | ".join(cleaned) if cleaned else ""))

    def get_me(self) -> Dict[str, Any]:
        resp = self._request("GET", "/api/v1/users/me", want_json=True, allow_redirects=True)
        resp.raise_for_status()
        data = self._ensure_json(resp)
        return data.get("data", data)

    def list_challenges(self) -> List[Dict[str, Any]]:
        resp = self._request("GET", "/api/v1/challenges", want_json=True, allow_redirects=True)
        resp.raise_for_status()
        data = self._ensure_json(resp)
        return data.get("data", [])

    def get_challenge(self, challenge_id: int) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/v1/challenges/{challenge_id}", want_json=True, allow_redirects=True)
        resp.raise_for_status()
        data = self._ensure_json(resp)
        return data.get("data", data)

    def get_scoreboard(self) -> Any:
        resp = self._request("GET", "/api/v1/scoreboard", want_json=True, allow_redirects=True)
        resp.raise_for_status()
        data = self._ensure_json(resp)
        return data.get("data", data)

    def download_challenge_files(self, challenge_id: int, outdir: str) -> List[DownloadedFile]:
        challenge = self.get_challenge(challenge_id)
        files = challenge.get("files") or []
        if not files:
            return []
        out = Path(outdir)
        out.mkdir(parents=True, exist_ok=True)
        results: List[DownloadedFile] = []
        for idx, url in enumerate(files, 1):
            full_url = urljoin(self.base_url + "/", url.lstrip("/"))
            filename = full_url.split("?")[0].rstrip("/").split("/")[-1] or f"file_{idx}"
            path = out / filename
            r = self._request("GET", full_url, stream=True, allow_redirects=True)
            r.raise_for_status()
            size = 0
            with path.open("wb") as fh:
                for chunk in r.iter_content(chunk_size=65536):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    size += len(chunk)
            results.append(DownloadedFile(url=full_url, path=str(path), size=size))
        return results

    def submit_flag(self, challenge_id: int, flag: str) -> Dict[str, Any]:
        payload = {"challenge_id": challenge_id, "submission": flag}
        resp = self._request("POST", "/api/v1/challenges/attempt", want_json=True, data=json.dumps(payload), allow_redirects=True)
        resp.raise_for_status()
        data = self._ensure_json(resp)
        return data.get("data", data)


def emit(data: Any, as_json: bool) -> None:
    if as_json or isinstance(data, (dict, list)):
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(data)


def main() -> int:
    parser = argparse.ArgumentParser(description="CTFd automation client")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--session-file", help="Session cache file. Defaults to .sessions/ctfd_<host>.json")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--insecure", action="store_true")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("probe")

    p = sub.add_parser("login")
    p.add_argument("--username", required=True)
    p.add_argument("--password", required=True)

    sub.add_parser("me")
    sub.add_parser("challenges")

    p = sub.add_parser("challenge")
    p.add_argument("--challenge-id", type=int, required=True)

    p = sub.add_parser("download")
    p.add_argument("--challenge-id", type=int, required=True)
    p.add_argument("--outdir", required=True)

    p = sub.add_parser("submit")
    p.add_argument("--challenge-id", type=int, required=True)
    p.add_argument("--flag", required=True)

    sub.add_parser("scoreboard")
    sub.add_parser("session")

    args = parser.parse_args()
    if not args.session_file:
        args.session_file = str(CTFdClient.default_session_file(args.base_url))
    client = CTFdClient(args.base_url, timeout=args.timeout, verify=not args.insecure, debug=args.debug)
    client.load_session(args.session_file)

    try:
        if args.cmd == "probe":
            emit(client.probe(), args.json)
        elif args.cmd == "login":
            data = client.login(args.username, args.password)
            data["session_cache"] = client.save_session(args.session_file)
            emit(data, args.json)
        elif args.cmd == "me":
            emit(client.get_me(), args.json)
        elif args.cmd == "challenges":
            emit(client.list_challenges(), args.json)
        elif args.cmd == "challenge":
            emit(client.get_challenge(args.challenge_id), args.json)
        elif args.cmd == "download":
            emit([d.__dict__ for d in client.download_challenge_files(args.challenge_id, args.outdir)], args.json)
        elif args.cmd == "submit":
            emit(client.submit_flag(args.challenge_id, args.flag), args.json)
        elif args.cmd == "scoreboard":
            emit(client.get_scoreboard(), args.json)
        elif args.cmd == "session":
            emit(
                {
                    "path": args.session_file,
                    "load": client.load_session(args.session_file),
                    "csrf_nonce": client.csrf_nonce,
                    "cookies": client.session.cookies.get_dict(),
                },
                args.json,
            )
        else:
            parser.error("unknown command")
    except Exception as exc:
        print(f"[!] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import random
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DEFAULT_TIMEOUT = 20
UA = "ctf-platform-manager-gzctf/0.1"
SESSION_DIR = Path(".sessions")


class GZCTFError(RuntimeError):
    pass


@dataclass
class DownloadedFile:
    url: str
    path: str
    size: int


class GZCTFClient:
    def __init__(
        self,
        base_url: str,
        token: Optional[str] = None,
        timeout: int = DEFAULT_TIMEOUT,
        verify: bool = True,
        debug: bool = False,
    ) -> None:
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
            }
        )
        if token:
            self.set_token(token)

    @staticmethod
    def default_session_file(base_url: str) -> Path:
        parsed = urlparse(base_url)
        host = (parsed.netloc or parsed.path or "default").replace(":", "_")
        return SESSION_DIR / f"gzctf_{host}.json"

    def log(self, *parts: Any) -> None:
        if self.debug:
            print("[DEBUG]", *parts, file=sys.stderr)

    def set_token(self, token: str) -> None:
        domain = urlparse(self.base_url).hostname or ""
        self.session.cookies.pop("GZCTF_Token", None)
        self.session.cookies.set("GZCTF_Token", token, domain=domain)

    def save_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "base_url": self.base_url,
            "token": self.token(),
            "cookies": self.session.cookies.get_dict(),
        }
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"saved": True, "path": str(target), "has_token": bool(data["token"])}

    def load_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        if not target.exists():
            return {"loaded": False, "path": str(target), "reason": "missing"}
        data = json.loads(target.read_text(encoding="utf-8"))
        token = data.get("token")
        if token:
            self.set_token(token)
        for key, value in (data.get("cookies") or {}).items():
            if key == "GZCTF_Token" and token:
                continue
            self.session.cookies.set(key, value)
        return {"loaded": True, "path": str(target), "has_token": bool(self.token())}

    def token(self) -> Optional[str]:
        for name in ["GZCTF_Token", ".AspNetCore.Identity.Application"]:
            for cookie in self.session.cookies:
                if cookie.name == name:
                    return cookie.value
        return None

    def _url(self, path_or_url: str) -> str:
        if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
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
            raise GZCTFError(f"Expected JSON from {resp.url}, got: {resp.text[:200]!r}") from exc

    def probe(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {"base_url": self.base_url, "cookies": list(self.session.cookies.keys())}
        for path in ["/", "/account/login?from=/", "/api/config", "/api/captcha", "/api/game?count=1&skip=0"]:
            try:
                r = self._request("GET", path, allow_redirects=True)
                info[path] = {"status": r.status_code, "content_type": r.headers.get("content-type", "")}
            except Exception as exc:
                info[path] = {"error": str(exc)}
        return info

    def get_client_config(self) -> Dict[str, Any]:
        r = self._request("GET", "/api/config")
        r.raise_for_status()
        return self._json(r)

    def get_captcha_info(self) -> Dict[str, Any]:
        r = self._request("GET", "/api/captcha")
        r.raise_for_status()
        return self._json(r)

    def get_pow_challenge(self) -> Dict[str, Any]:
        r = self._request("GET", "/api/captcha/powchallenge")
        r.raise_for_status()
        return self._json(r)

    @staticmethod
    def encrypt_password(password: str, public_key_b64: Optional[str]) -> str:
        if not public_key_b64:
            return password
        public_key = X25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64))
        eph_private = X25519PrivateKey.generate()
        eph_public = eph_private.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        shared = eph_private.exchange(public_key)
        digest = hashes.Hash(hashes.SHA256())
        digest.update(shared)
        aes_key = digest.finalize()
        iv = os.urandom(12)
        ciphertext = AESGCM(aes_key).encrypt(iv, password.encode(), None)
        return base64.b64encode(eph_public + iv + ciphertext).decode()

    @staticmethod
    def _count_leading_zero_bits(data: bytes) -> int:
        total = 0
        for byte in data:
            if byte == 0:
                total += 8
                continue
            mask = 0x80
            while mask and (byte & mask) == 0:
                total += 1
                mask >>= 1
            break
        return total

    def solve_pow(self, chall: Dict[str, Any]) -> str:
        chall_hex = chall["challenge"]
        difficulty = int(chall["difficulty"])
        prefix = bytes.fromhex(chall_hex)
        seed = random.getrandbits(32)
        nonce = seed
        started = time.time()
        while True:
            nonce_bytes = nonce.to_bytes(4, "big", signed=False)
            digest = hashlib.sha256(prefix + nonce_bytes).digest()
            if self._count_leading_zero_bits(digest) >= difficulty:
                elapsed = time.time() - started
                self.log("pow_solved", {"nonce": nonce, "difficulty": difficulty, "elapsed": elapsed})
                return f"{chall['id']}:{nonce:08x}"
            nonce = (nonce + 1) & 0xFFFFFFFF

    def build_login_payload(
        self,
        username: str,
        password: str,
        captcha_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        config = self.get_client_config()
        captcha = self.get_captcha_info()
        payload: Dict[str, Any] = {
            "userName": username,
            "password": self.encrypt_password(password, config.get("apiPublicKey")),
        }
        captcha_type = (captcha.get("type") or "None").lower()
        if captcha_type == "none":
            return payload
        if captcha_token:
            payload["challenge"] = captcha_token
            return payload
        if captcha_type == "hashpow":
            payload["challenge"] = self.solve_pow(self.get_pow_challenge())
            return payload
        raise GZCTFError(
            f"Unsupported interactive captcha type for headless login: {captcha.get('type')}. "
            "Pass --captcha-token if you solved it externally."
        )

    def _verify_login(self) -> Dict[str, Any]:
        candidates = [
            "/api/account/profile",
            "/api/account/me",
            "/api/account",
            "/api/user/profile",
            "/api/user/info",
        ]
        last_err = None
        for path in candidates:
            try:
                r = self._request("GET", path)
                if r.status_code == 200 and "json" in r.headers.get("content-type", ""):
                    data = self._json(r)
                    return {"endpoint": path, "profile": data}
            except Exception as exc:
                last_err = exc
        if self.token():
            return {"endpoint": None, "profile": None, "token_only": True}
        if last_err:
            raise GZCTFError(f"Login appears unsuccessful: {last_err}")
        raise GZCTFError("Login appears unsuccessful")

    def login(
        self,
        username: str,
        password: str,
        remember_me: bool = True,
        captcha_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        primary_payload = self.build_login_payload(username, password, captcha_token=captcha_token)
        json_payloads = [
            {**primary_payload, "rememberMe": remember_me},
            {**primary_payload, "username": primary_payload["userName"]},
            {**primary_payload, "UserName": primary_payload["userName"]},
        ]
        api_errors: List[str] = []
        for payload in json_payloads:
            try:
                r = self._request(
                    "POST",
                    "/api/account/login",
                    json=payload,
                    headers={"Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest"},
                    allow_redirects=True,
                )
                if r.status_code < 400 and self.token():
                    proof = self._verify_login()
                    return {
                        "method": "api-json",
                        "payload_keys": list(payload.keys()),
                        "token": self.session.cookies.get("GZCTF_Token"),
                        "cookies": self.session.cookies.get_dict(),
                        **proof,
                    }
                if r.status_code in (200, 204) and not r.text.strip():
                    proof = self._verify_login()
                    return {
                        "method": "api-json",
                        "payload_keys": list(payload.keys()),
                        "token": self.session.cookies.get("GZCTF_Token"),
                        "cookies": self.session.cookies.get_dict(),
                        **proof,
                    }
                api_errors.append(f"{payload.keys()} -> {r.status_code} {r.text[:120]!r}")
            except Exception as exc:
                api_errors.append(f"{payload.keys()} -> {exc}")

        try:
            login_page = self._request("GET", "/account/login?from=/", allow_redirects=True)
            html = login_page.text
            form_action = re.search(r'<form[^>]+method=["\']post["\'][^>]+action=["\']([^"\']+)', html, re.I)
            action = form_action.group(1) if form_action else "/account/login?from=/"
            hidden_inputs = dict(re.findall(r'<input[^>]+type=["\']hidden["\'][^>]+name=["\']([^"\']+)["\'][^>]*value=["\']([^"\']*)', html, re.I))
            fields = dict(hidden_inputs)
            username_keys = ["Input.UserName", "Input.Username", "UserName", "Username", "username"]
            password_keys = ["Input.Password", "Password", "password"]
            remember_keys = ["Input.RememberMe", "RememberMe", "rememberMe"]
            submit_keys = ["button", "handler", "action"]
            for key in username_keys:
                fields[key] = username
            for key in password_keys:
                fields[key] = password
            for key in remember_keys:
                fields[key] = "true"
            for key in submit_keys:
                fields.setdefault(key, "login")
            r = self._request(
                "POST",
                action,
                data=fields,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                allow_redirects=True,
            )
            if r.status_code < 400 and self.token():
                proof = self._verify_login()
                return {
                    "method": "html-form",
                    "form_action": action,
                    "token": self.token(),
                    "cookies": self.session.cookies.get_dict(),
                    **proof,
                }
            api_errors.append(f"html-form -> {r.status_code} {r.text[:120]!r}")
        except Exception as exc:
            api_errors.append(f"html-form -> {exc}")

        raise GZCTFError("Login failed. Attempts: " + " | ".join(api_errors))

    def list_games(self, count: int = 50, skip: int = 0) -> Dict[str, Any]:
        r = self._request("GET", f"/api/game?count={count}&skip={skip}")
        r.raise_for_status()
        return self._json(r)

    def list_recent_games(self, limit: int = 0) -> List[Dict[str, Any]]:
        r = self._request("GET", f"/api/game/recent?limit={limit}")
        r.raise_for_status()
        return self._json(r)

    def get_game(self, game_id: int) -> Dict[str, Any]:
        r = self._request("GET", f"/api/game/{game_id}")
        r.raise_for_status()
        return self._json(r)

    def list_teams(self) -> List[Dict[str, Any]]:
        r = self._request("GET", "/api/team")
        r.raise_for_status()
        return self._json(r)

    def create_team(self, name: str, bio: str = "") -> Dict[str, Any]:
        r = self._request(
            "POST",
            "/api/team",
            json={"name": name, "bio": bio},
            headers={"Content-Type": "application/json"},
        )
        r.raise_for_status()
        return self._json(r)

    def join_game(
        self,
        game_id: int,
        team_id: int,
        division_id: Optional[int] = None,
        invite_code: Optional[str] = None,
    ) -> Any:
        payload: Dict[str, Any] = {"teamId": team_id}
        if division_id is not None:
            payload["divisionId"] = division_id
        if invite_code:
            payload["inviteCode"] = invite_code
        r = self._request(
            "POST",
            f"/api/game/{game_id}",
            json=payload,
            headers={"Content-Type": "application/json"},
        )
        r.raise_for_status()
        if not r.text.strip():
            return {"joined": True}
        ctype = r.headers.get("content-type", "")
        return self._json(r) if "json" in ctype else r.text.strip()

    def get_game_details(self, game_id: int) -> Dict[str, Any]:
        r = self._request("GET", f"/api/game/{game_id}/details")
        r.raise_for_status()
        return self._json(r)

    def get_challenge(self, game_id: int, challenge_id: int) -> Dict[str, Any]:
        r = self._request("GET", f"/api/game/{game_id}/challenges/{challenge_id}")
        r.raise_for_status()
        return self._json(r)

    def download_challenge_attachments(self, game_id: int, challenge_id: int, outdir: str) -> List[DownloadedFile]:
        data = self.get_challenge(game_id, challenge_id)
        attachments = []
        if isinstance(data.get("attachment"), dict):
            attachments.append(data["attachment"])
        attachments.extend(data.get("attachments", []) or [])
        context = data.get("context") or {}
        if isinstance(context, dict) and context.get("url"):
            attachments.append(
                {
                    "url": context["url"],
                    "fileName": context.get("fileName"),
                }
            )
        attachments = [a for a in attachments if isinstance(a, dict) and a.get("url")]
        if not attachments:
            return []

        out = Path(outdir)
        out.mkdir(parents=True, exist_ok=True)
        results: List[DownloadedFile] = []

        for idx, att in enumerate(attachments, 1):
            raw_url = att["url"]
            full_url = urljoin(self.base_url + "/", raw_url.lstrip("/")) if raw_url.startswith("/") else raw_url
            filename = att.get("fileName") or Path(urlparse(full_url).path).name or f"attachment_{idx}"
            path = out / filename
            r = self._request("GET", full_url, stream=True)
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

    def submit_flag(
        self,
        game_id: int,
        challenge_id: int,
        flag: str,
        poll: bool = True,
        poll_interval: float = 1.5,
        poll_attempts: int = 8,
    ) -> Dict[str, Any]:
        encrypted_flag = self.encrypt_password(flag, self.get_client_config().get("apiPublicKey"))
        r = self._request(
            "POST",
            f"/api/game/{game_id}/challenges/{challenge_id}",
            json={"flag": encrypted_flag},
            headers={"Content-Type": "application/json"},
        )
        r.raise_for_status()
        try:
            submit_id = self._json(r)
        except Exception:
            submit_id = r.text.strip()
        result: Dict[str, Any] = {"submit_id": submit_id}
        if not poll:
            return result
        for attempt in range(1, poll_attempts + 1):
            time.sleep(poll_interval)
            status = self.get_submission_status(game_id, challenge_id, submit_id)
            result["status"] = status
            result["attempt"] = attempt
            if isinstance(status, str) and status not in {"FlagSubmitted", "Pending", "Queued", "Running"}:
                break
        return result

    def get_submission_status(self, game_id: int, challenge_id: int, submit_id: Any) -> Any:
        r = self._request("GET", f"/api/game/{game_id}/challenges/{challenge_id}/status/{submit_id}")
        r.raise_for_status()
        ctype = r.headers.get("content-type", "")
        return self._json(r) if "json" in ctype else r.text.strip()


def emit(data: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return
    if isinstance(data, (dict, list)):
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(data)


def build_client(args: argparse.Namespace) -> GZCTFClient:
    token = args.token or os.getenv("GZCTF_TOKEN")
    client = GZCTFClient(
        base_url=args.base_url,
        token=token,
        timeout=args.timeout,
        verify=not args.insecure,
        debug=args.debug,
    )
    if getattr(args, "session_file", None):
        client.load_session(args.session_file)
    return client


def add_common(sub: argparse.ArgumentParser) -> None:
    sub.add_argument("--base-url", required=True, help="Base URL, e.g. https://ctf.example.com")
    sub.add_argument("--token", help="Existing GZCTF_Token cookie value")
    sub.add_argument("--session-file", help="Session cache file. Defaults to .sessions/gzctf_<host>.json")
    sub.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    sub.add_argument("--insecure", action="store_true", help="Disable TLS verification")
    sub.add_argument("--debug", action="store_true")
    sub.add_argument("--json", action="store_true", help="JSON output")


def main() -> int:
    parser = argparse.ArgumentParser(description="GZCTF automation client")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("probe", help="Probe basic reachability")
    add_common(p)

    p = sub.add_parser("login", help="Login with username/password")
    add_common(p)
    p.add_argument("--username", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--captcha-token", help="Pre-solved Turnstile or other external captcha token, if needed")

    p = sub.add_parser("games", help="List games")
    add_common(p)
    p.add_argument("--count", type=int, default=50)
    p.add_argument("--skip", type=int, default=0)
    p.add_argument("--recent", action="store_true")
    p.add_argument("--limit", type=int, default=0)

    p = sub.add_parser("teams", help="List teams visible to the current account")
    add_common(p)

    p = sub.add_parser("join", help="Join a game with an existing team")
    add_common(p)
    p.add_argument("--game-id", type=int, required=True)
    p.add_argument("--team-id", type=int, required=True)
    p.add_argument("--division-id", type=int)
    p.add_argument("--invite-code")

    p = sub.add_parser("game", help="Get a game's public info")
    add_common(p)
    p.add_argument("--game-id", type=int, required=True)
    p.add_argument("--details", action="store_true", help="Use authenticated /details endpoint")

    p = sub.add_parser("challenge", help="Get a challenge's detail")
    add_common(p)
    p.add_argument("--game-id", type=int, required=True)
    p.add_argument("--challenge-id", type=int, required=True)

    p = sub.add_parser("download", help="Download challenge attachments")
    add_common(p)
    p.add_argument("--game-id", type=int, required=True)
    p.add_argument("--challenge-id", type=int, required=True)
    p.add_argument("--outdir", required=True)

    p = sub.add_parser("submit", help="Submit flag")
    add_common(p)
    p.add_argument("--game-id", type=int, required=True)
    p.add_argument("--challenge-id", type=int, required=True)
    p.add_argument("--flag", required=True)
    p.add_argument("--no-poll", action="store_true")
    p.add_argument("--poll-interval", type=float, default=1.5)
    p.add_argument("--poll-attempts", type=int, default=8)

    p = sub.add_parser("session", help="Inspect or refresh cached session")
    add_common(p)

    args = parser.parse_args()
    if not getattr(args, "session_file", None):
        args.session_file = str(GZCTFClient.default_session_file(args.base_url))
    client = build_client(args)

    try:
        if args.cmd == "probe":
            emit(client.probe(), args.json)
        elif args.cmd == "login":
            data = client.login(args.username, args.password, captcha_token=args.captcha_token)
            data["session"] = client.save_session(args.session_file)
            emit(data, args.json)
        elif args.cmd == "games":
            data = client.list_recent_games(args.limit) if args.recent else client.list_games(args.count, args.skip)
            emit(data, args.json)
        elif args.cmd == "teams":
            emit(client.list_teams(), args.json)
        elif args.cmd == "join":
            emit(client.join_game(args.game_id, args.team_id, args.division_id, args.invite_code), args.json)
        elif args.cmd == "game":
            data = client.get_game_details(args.game_id) if args.details else client.get_game(args.game_id)
            emit(data, args.json)
        elif args.cmd == "challenge":
            emit(client.get_challenge(args.game_id, args.challenge_id), args.json)
        elif args.cmd == "download":
            data = [d.__dict__ for d in client.download_challenge_attachments(args.game_id, args.challenge_id, args.outdir)]
            emit(data, args.json)
        elif args.cmd == "submit":
            data = client.submit_flag(
                args.game_id,
                args.challenge_id,
                args.flag,
                poll=not args.no_poll,
                poll_interval=args.poll_interval,
                poll_attempts=args.poll_attempts,
            )
            emit(data, args.json)
        elif args.cmd == "session":
            emit(
                {
                    "path": args.session_file,
                    "load": client.load_session(args.session_file),
                    "token": client.token(),
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

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote

import requests

DEFAULT_TIMEOUT = 20
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
SESSION_DIR = Path(".sessions")
TOKEN_COOKIE = "cr_jwttoken"
DEFAULT_BASE_URL = "https://adworld.xctf.org.cn"


class AdWorldError(RuntimeError):
    pass


@dataclass
class DownloadedFile:
    url: str
    path: str
    size: int


class AdWorldClient:
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
            }
        )
        self.token: Optional[str] = None
        self.user: Optional[Dict[str, Any]] = None
        self._refresh_common_headers()

    @staticmethod
    def _decode_jwt_payload(token: Optional[str]) -> Dict[str, Any]:
        if not token:
            return {}
        raw = token.strip()
        if raw.startswith("JWT "):
            raw = raw[4:].strip()
        parts = raw.split(".")
        if len(parts) != 3:
            return {}
        payload = parts[1]
        padding = "=" * (-len(payload) % 4)
        try:
            decoded = base64.urlsafe_b64decode(payload + padding).decode("utf-8")
            data = json.loads(decoded)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def token_payload(self) -> Dict[str, Any]:
        return self._decode_jwt_payload(self.token)

    def token_expiry(self) -> Optional[int]:
        payload = self.token_payload()
        exp = payload.get("exp")
        return int(exp) if isinstance(exp, (int, float)) else None

    def token_expired(self) -> Optional[bool]:
        exp = self.token_expiry()
        if exp is None:
            return None
        return int(datetime.now(tz=timezone.utc).timestamp()) >= exp

    def cache_state(self) -> Dict[str, Any]:
        exp = self.token_expiry()
        return {
            "token_present": bool(self.token),
            "token_expired": self.token_expired(),
            "token_expiry": exp,
            "token_expiry_iso": datetime.fromtimestamp(exp, tz=timezone.utc).isoformat() if exp else None,
            "cookies": self.session.cookies.get_dict(),
            "user": self.user,
        }

    @staticmethod
    def default_session_file(base_url: str) -> Path:
        host = base_url.split("://", 1)[-1].replace("/", "_").replace(":", "_")
        return SESSION_DIR / f"adworld_{host}.json"

    def log(self, *parts: Any) -> None:
        if self.debug:
            print("[DEBUG]", *parts, file=sys.stderr)

    def _refresh_common_headers(self) -> None:
        self.session.headers.update(
            {
                "Origin": self.base_url,
                "Referer": self.base_url + "/login",
            }
        )
        if self.token:
            self.session.headers["Authorization"] = self.token
            self.session.cookies.set(TOKEN_COOKIE, self.token)
        else:
            self.session.headers.pop("Authorization", None)

    def _url(self, path_or_url: str) -> str:
        if path_or_url.startswith(("http://", "https://")):
            return path_or_url
        if not path_or_url.startswith("/"):
            path_or_url = "/" + path_or_url
        return self.base_url + path_or_url

    def _request(self, method: str, path: str, want_json: bool = False, **kwargs: Any) -> requests.Response:
        url = self._url(path)
        kwargs.setdefault("timeout", self.timeout)
        headers = dict(kwargs.pop("headers", {}) or {})
        if want_json:
            headers.setdefault("Accept", "application/json, text/plain, */*")
        resp = self.session.request(method, url, headers=headers, **kwargs)
        self.log(method, url, "->", resp.status_code, resp.headers.get("content-type", ""))
        return resp

    def _json(self, resp: requests.Response) -> Any:
        try:
            return resp.json()
        except Exception as exc:
            raise AdWorldError(f"Expected JSON from {resp.url}, got: {resp.text[:200]!r}") from exc

    def _unwrap(self, resp: requests.Response) -> Dict[str, Any]:
        data = self._json(resp)
        if not isinstance(data, dict):
            raise AdWorldError(f"Unexpected response shape from {resp.url}: {data!r}")
        code = data.get("code")
        if code and not str(code).endswith("000000"):
            raise AdWorldError(f"API error {code}: {data.get('message') or data.get('detail') or data}")
        return data

    def save_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = self.token_payload()
        data = {
            "base_url": self.base_url,
            "token": self.token,
            "token_payload": payload,
            "token_expiry": payload.get("exp"),
            "token_expired": self.token_expired(),
            "cookies": self.session.cookies.get_dict(),
            "user": self.user,
        }
        target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"saved": True, "path": str(target), **self.cache_state()}

    def load_session(self, path: str) -> Dict[str, Any]:
        target = Path(path)
        if not target.exists():
            return {"loaded": False, "path": str(target), "reason": "missing"}
        data = json.loads(target.read_text(encoding="utf-8"))
        self.token = data.get("token")
        self.user = data.get("user")
        for key, value in (data.get("cookies") or {}).items():
            self.session.cookies.set(key, value)
        if not self.token:
            self.token = self.session.cookies.get(TOKEN_COOKIE)
        self._refresh_common_headers()
        return {"loaded": True, "path": str(target), **self.cache_state()}

    def persist_current_session(self, path: Optional[str]) -> Optional[Dict[str, Any]]:
        if not path:
            return None
        return self.save_session(path)

    def probe(self) -> Dict[str, Any]:
        info: Dict[str, Any] = {"base_url": self.base_url}
        for path in ["/login", "/api/ad/community/public/events/", "/api/ad/auth/web/current_auth/"]:
            try:
                r = self._request("GET", path, allow_redirects=True)
                item: Dict[str, Any] = {
                    "status": r.status_code,
                    "content_type": r.headers.get("content-type", ""),
                }
                if "text/html" in item["content_type"]:
                    item["title"] = re.search(r"<title>(.*?)</title>", r.text, re.I | re.S).group(1) if re.search(r"<title>(.*?)</title>", r.text, re.I | re.S) else ""
                else:
                    try:
                        item["body"] = self._json(r)
                    except Exception:
                        item["body_preview"] = r.text[:300]
                info[path] = item
            except Exception as exc:
                info[path] = {"error": str(exc)}
        return info

    def login(self, username: str, password: str) -> Dict[str, Any]:
        payload = {"username": username, "password": password, "captcha": None}
        resp = self._request("POST", "/api/ad/auth/web/login/", json=payload, want_json=True)
        resp.raise_for_status()
        data = self._unwrap(resp)
        body = data.get("data") or {}
        token = body.get("token")
        if not token:
            raise AdWorldError(f"Login did not return token: {data}")
        self.token = token
        self.user = body.get("user") or {}
        self._refresh_common_headers()
        return {
            "success": True,
            "method": "json",
            "token": self.token,
            "user": self.user,
            "cookies": self.session.cookies.get_dict(),
        }

    def current_auth(self) -> Dict[str, Any]:
        resp = self._request("GET", "/api/ad/auth/web/current_auth/", want_json=True)
        resp.raise_for_status()
        data = self._unwrap(resp).get("data") or {}
        token = data.get("token")
        if token:
            self.token = token
            self._refresh_common_headers()
        self.user = data.get("user") or self.user
        return data

    def competitions(self, page: int = 1, per_page: int = 10, category: Optional[int] = None, search: str = "", progress: Optional[int] = None, public: bool = False) -> Dict[str, Any]:
        path = "/api/ad/community/public/events/" if public else "/api/ad/community/web/events/"
        params: Dict[str, Any] = {"page": page, "per_page": per_page}
        if category is not None:
            params["category"] = category
        if search:
            params["search"] = search
        if progress is not None:
            params["progress"] = progress
        resp = self._request("GET", path, params=params, want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def competition(self, competition_id: str, public: bool = False) -> Dict[str, Any]:
        path = f"/api/ad/community/public/events/{competition_id}/" if public else f"/api/ad/community/web/events/{competition_id}/"
        resp = self._request("GET", path, want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def query_in_race(self, races: List[Dict[str, Any]]) -> Dict[str, Any]:
        filtered = [r for r in races if r.get("resource_id")]
        if not filtered:
            return {}
        resp = self._request("POST", "/api/ct/web/arena/arena/adsaas/query_in_race/", json={"races": filtered}, want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def enter_race(self, race_id: str, category: int) -> Dict[str, Any]:
        if category == 20:
            path = f"/api/ct/web/aic_race/races/{race_id}/enter/"
        elif category == 0:
            path = f"/api/ct/web/theory_race/exam/enroll/?exam_id={race_id}"
        else:
            path = f"/api/ct/web/jeopardy_race/race/{race_id}/enroll/"
        resp = self._request("GET", path, want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp)

    def race_info(self, race_id: str) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/ct/web/jeopardy_race/race/{race_id}/info/", want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def race_base(self, race_id: str) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/ct/web/jeopardy_race/race/{race_id}/base/", want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def race_summary_checkpoints(self, race_id: str) -> List[Dict[str, Any]]:
        resp = self._request("GET", f"/api/ct/web/jeopardy_race/race/{race_id}/summary/checkpoints/", want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or []

    def race_checkpoints(self, race_id: str, direction: str = "", query: str = "") -> Dict[str, Any]:
        params: Dict[str, Any] = {}
        if direction:
            params["direction"] = direction
        if query:
            params["query"] = query
        resp = self._request("GET", f"/api/ct/web/jeopardy_race/race/{race_id}/checkpoints/", params=params, want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def race_checkpoint_detail(self, race_id: str, checkpoint_id: str) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/ct/web/jeopardy_race/race/{race_id}/checkpoints/{checkpoint_id}/", want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def download_race_attachment(self, race_id: str, checkpoint_id: str, outdir: str) -> List[DownloadedFile]:
        detail = self.race_checkpoint_detail(race_id, checkpoint_id)
        attachment = detail.get("attachment") or {}
        file_url = attachment.get("url") or ""
        if not file_url:
            return []
        file_name = attachment.get("name") or file_url.rstrip("/").split("/")[-1] or f"{checkpoint_id}.bin"
        out = Path(outdir)
        out.mkdir(parents=True, exist_ok=True)
        path = out / file_name
        r = self._request("GET", file_url, stream=True, allow_redirects=True)
        r.raise_for_status()
        size = 0
        with path.open("wb") as fh:
            for chunk in r.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                fh.write(chunk)
                size += len(chunk)
        return [DownloadedFile(url=self._url(file_url), path=str(path), size=size)]

    def submit_race_flag(self, race_id: str, checkpoint_id: str, flag: str) -> Dict[str, Any]:
        resp = self._request(
            "POST",
            f"/api/ct/web/jeopardy_race/race/{race_id}/flag/",
            json={"checkpoint_id": checkpoint_id, "flag": flag},
            want_json=True,
        )
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def practice_categories(self, practice_set_id: str, practice_type: int) -> List[Dict[str, Any]]:
        resp = self._request(
            "GET",
            "/api/ojj/oj/practice/category/list",
            params={"practice_set_id": practice_set_id, "practice_type": practice_type},
            want_json=True,
        )
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or []

    def practice_set_detail(self, resource_id: str) -> Dict[str, Any]:
        resp = self._request(
            "GET",
            "/api/ojj/oj/practice/set/detail",
            params={"resource_id": resource_id},
            want_json=True,
        )
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def theory_list(self, practice_set_id: str, pattern: str = "", category_id: str = "", solved: Optional[int] = None, difficulty: Optional[int] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {"practice_set_id": practice_set_id}
        if pattern:
            params["pattern"] = pattern
        if category_id:
            params["category_id"] = category_id
        if solved is not None:
            params["solved"] = solved
        if difficulty is not None:
            params["difficulty"] = difficulty
        resp = self._request("GET", "/api/ojj/oj/practice/theory/list", params=params, want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def operation_list(self, practice_set_id: str, pattern: str = "", category_id: str = "", solved: Optional[int] = None, difficulty: Optional[int] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {"practice_set_id": practice_set_id}
        if pattern:
            params["pattern"] = pattern
        if category_id:
            params["categoryId"] = category_id
        if solved is not None:
            params["solved"] = solved
        if difficulty is not None:
            params["difficulty"] = difficulty
        resp = self._request("GET", "/api/ojj/oj/practice/operation/list", params=params, want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def operation_detail(self, resource_id: str) -> Dict[str, Any]:
        resp = self._request("GET", "/api/ojj/oj/practice/operation", params={"resource_id": resource_id}, want_json=True)
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def download_operation_attachment(self, resource_id: str, outdir: str) -> List[DownloadedFile]:
        detail = self.operation_detail(resource_id)
        file_url = detail.get("file_url") or ""
        if not file_url:
            return []
        file_name = detail.get("file_name") or file_url.rstrip("/").split("/")[-1] or f"{resource_id}.bin"
        quoted_name = quote(file_name)
        download_url = self._url(f"/download{file_url}?attname={quoted_name}")
        out = Path(outdir)
        out.mkdir(parents=True, exist_ok=True)
        path = out / file_name
        r = self._request("GET", download_url, stream=True, allow_redirects=True)
        r.raise_for_status()
        size = 0
        with path.open("wb") as fh:
            for chunk in r.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                fh.write(chunk)
                size += len(chunk)
        return [DownloadedFile(url=download_url, path=str(path), size=size)]

    def submit_flag(self, resource_id: str, flag: str, again: bool = False) -> Dict[str, Any]:
        path = "/api/ojj/oj/practice/operation/submit_answer_again" if again else "/api/ojj/oj/practice/operation/submit_answer"
        resp = self._request(
            "POST",
            path,
            json={"resource_id": resource_id, "submit_answer": flag},
            want_json=True,
        )
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}


    @staticmethod
    def _walk_values(obj: Any):
        if isinstance(obj, dict):
            yield obj
            for value in obj.values():
                yield from AdWorldClient._walk_values(value)
        elif isinstance(obj, list):
            for item in obj:
                yield from AdWorldClient._walk_values(item)

    @staticmethod
    def _looks_like_adworld_id(value: str) -> bool:
        s = str(value or "").strip()
        return bool(re.fullmatch(r"[0-9a-fA-F]{16,64}", s))

    @staticmethod
    def _items_from_listing(data: Any) -> List[Dict[str, Any]]:
        if not isinstance(data, dict):
            return []
        for key in ("list", "results", "items", "events", "rows", "data"):
            value = data.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
        return []

    def find_competition(self, query: str, page_limit: int = 5, per_page: int = 20) -> Dict[str, Any]:
        """Find one event by id/name/search keyword.

        Upper layers may pass `ACTF`, `ACTF 2026`, or an event/race id. This
        method keeps AdWorld's separate search/detail endpoints internal.
        """
        q = str(query or "").strip()
        if not q:
            raise AdWorldError("empty competition query")

        # Direct event id first.
        if self._looks_like_adworld_id(q):
            for public in (False, True):
                try:
                    detail = self.competition(q, public=public)
                    if detail:
                        return detail
                except Exception:
                    pass

        candidates: List[Dict[str, Any]] = []
        for public in (False, True):
            for page in range(1, page_limit + 1):
                try:
                    data = self.competitions(page=page, per_page=per_page, search=q, public=public)
                    items = self._items_from_listing(data)
                    candidates.extend(items)
                    if not items:
                        break
                except Exception:
                    break
            if candidates:
                break

        if not candidates:
            raise AdWorldError(f"No AdWorld competition found for query={q!r}")

        ql = q.lower()
        def score(item: Dict[str, Any]) -> tuple[int, str]:
            iid = str(item.get("id") or item.get("event_id") or "")
            name = str(item.get("name") or item.get("title") or "")
            if iid == q:
                return (0, name)
            if name.lower() == ql:
                return (1, name)
            if ql in name.lower():
                return (2, name)
            return (9, name)

        candidates.sort(key=score)
        chosen = candidates[0]
        cid = chosen.get("id") or chosen.get("event_id")
        if cid:
            for public in (False, True):
                try:
                    detail = self.competition(str(cid), public=public)
                    if detail:
                        return detail
                except Exception:
                    pass
        return chosen

    @staticmethod
    def _race_id_from_url(value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        # Examples: /saas/contest/web/contest/flag/<race_id>/GuidePage
        m = re.search(r"/flag/([0-9a-fA-F]{16,64})(?:/|$)", value)
        if m:
            return m.group(1)
        m = re.search(r"race[_-]?id=([0-9a-fA-F]{16,64})", value, re.I)
        if m:
            return m.group(1)
        return None

    def _race_candidates_from_competition(self, detail: Dict[str, Any], fallback_id: str) -> List[Dict[str, Any]]:
        """Best-effort extraction of playable race records from an event detail.

        AdWorld community event ids and playable race ids are not always the same.
        This helper keeps that split internal to the client by scanning common
        fields returned by event detail APIs and normalizing them to
        {resource_id, category} records accepted by query/enter/checkpoint APIs.
        """
        candidates: List[Dict[str, Any]] = []
        seen = set()

        def add(rid: Any, category: Any = None, raw: Optional[Dict[str, Any]] = None) -> None:
            if rid in (None, "", 0, "0") and raw:
                rid = self._race_id_from_url(raw.get("race_url") or raw.get("url") or raw.get("href"))
            if rid in (None, "", 0, "0"):
                return
            key = str(rid)
            if key in seen:
                return
            seen.add(key)
            cat = category
            if cat is None and raw:
                cat = raw.get("category") or raw.get("type") or raw.get("race_type")
            try:
                cat_i = int(cat) if cat is not None else 2
            except Exception:
                cat_i = 2
            candidates.append({"resource_id": key, "category": cat_i, "raw": raw or {}})

        for node in self._walk_values(detail):
            # Race URL can contain the true race id even when the surrounding
            # object's `id` is only an event-race relation id.
            for url_key in ("race_url", "url", "href"):
                if url_key in node:
                    add(self._race_id_from_url(node.get(url_key)), node.get("category") or node.get("race_type"), node)
            # Common race object shapes. Prefer race_id over id.
            for key in ("resource_id", "race_id", "exam_id", "id"):
                if key in node and any(k in node for k in ("category", "race_type", "checkpoints", "resource_id", "race_id", "race_url", "start_time", "end_time")):
                    add(node.get(key), node.get("category") or node.get("race_type"), node)
            # Some event objects carry a direct resource id for the playable race.
            if "resource_id" in node:
                add(node.get("resource_id"), node.get("category"), node)

        # Last fallback: many race APIs use the id directly.
        add(fallback_id, detail.get("category") if isinstance(detail, dict) else None, detail if isinstance(detail, dict) else None)
        return candidates

    def resolve_play_target(self, contest_id: str) -> Dict[str, Any]:
        """Resolve a public event/practice id to a concrete playable target.

        Returns {kind: 'race'|'practice', id: ..., category: ..., detail: ...}.
        The adapter calls this so upper layers never pass race_id/practice_set_id.
        `contest_id` must be an exact id returned by the contest listing (or a
        direct race/practice id); this deliberately does not keyword-match names.
        """
        cid = str(contest_id).strip()
        # 1) If it is already a jeopardy race id, this is the cheapest path.
        try:
            info = self.race_info(cid)
            if info:
                return {"kind": "race", "id": cid, "category": int(info.get("category") or 2), "detail": info, "entry_query": cid}
        except Exception:
            pass

        # 2) Event detail may point to one or more playable races.  Only exact
        # event ids are accepted; use `competitions/list_contests` first to
        # obtain the id and normalized `--contest-id` usage hints.
        detail: Dict[str, Any] = {}
        for public in (False, True):
            try:
                detail = self.competition(cid, public=public)
                if detail:
                    break
            except Exception:
                continue
        if detail:
            races = self._race_candidates_from_competition(detail, cid)
            for race in races:
                rid = str(race.get("resource_id"))
                try:
                    self.race_info(rid)
                    return {"kind": "race", "id": rid, "category": int(race.get("category") or 2), "detail": detail, "race": race}
                except Exception:
                    continue
            if races:
                race = races[0]
                return {"kind": "race", "id": str(race["resource_id"]), "category": int(race.get("category") or 2), "detail": detail, "race": race}

        # 3) Some AdWorld ids are practice-set ids.
        try:
            practice = self.practice_set_detail(cid)
            if practice:
                return {"kind": "practice", "id": cid, "detail": practice}
        except Exception:
            pass

        raise AdWorldError(f"Cannot resolve AdWorld contest/practice target from id={contest_id!r}")

    def contest_entry(self, contest_id_or_query: str) -> Dict[str, Any]:
        """Return normalized event/race entry for an exact contest/race id."""
        target = self.resolve_play_target(contest_id_or_query)
        detail = target.get("detail") if isinstance(target.get("detail"), dict) else {}
        race = target.get("race") if isinstance(target.get("race"), dict) else {}
        return {
            "query": contest_id_or_query,
            "kind": target.get("kind"),
            "target_id": target.get("id"),
            "category": target.get("category"),
            "event_id": detail.get("id"),
            "event_name": detail.get("name") or detail.get("title"),
            "race_url": race.get("raw", {}).get("race_url") if isinstance(race.get("raw"), dict) else race.get("race_url"),
            "race": race,
        }

    def enter_contest(self, contest_id: str) -> Dict[str, Any]:
        target = self.resolve_play_target(contest_id)
        if target["kind"] == "race":
            return self.enter_race(target["id"], int(target.get("category") or 2))
        return {"success": True, "kind": "practice", "id": target["id"], "message": "practice set does not require enter"}

    def contest_challenges(self, contest_id: str, page: int = 1, page_size: int = 50, search: str = "") -> Any:
        target = self.resolve_play_target(contest_id)
        if target["kind"] == "race":
            return self.race_checkpoints(target["id"], query=search or "")
        return self.operation_list(target["id"], pattern=search or "")

    def contest_challenge_detail(self, contest_id: Optional[str], challenge_id: str) -> Dict[str, Any]:
        if contest_id:
            target = self.resolve_play_target(contest_id)
            if target["kind"] == "race":
                return self.race_checkpoint_detail(target["id"], challenge_id)
        return self.operation_detail(challenge_id)

    def contest_download_attachment(self, contest_id: Optional[str], challenge_id: str, outdir: str) -> List[DownloadedFile]:
        if contest_id:
            target = self.resolve_play_target(contest_id)
            if target["kind"] == "race":
                return self.download_race_attachment(target["id"], challenge_id, outdir)
        return self.download_operation_attachment(challenge_id, outdir)

    def contest_submit_flag(self, contest_id: Optional[str], challenge_id: str, flag: str) -> Dict[str, Any]:
        if contest_id:
            target = self.resolve_play_target(contest_id)
            if target["kind"] == "race":
                return self.submit_race_flag(target["id"], challenge_id, flag)
        return self.submit_flag(challenge_id, flag)

    def contest_scoreboard(self, contest_id: str) -> Any:
        target = self.resolve_play_target(contest_id)
        if target["kind"] != "race":
            raise AdWorldError("Practice set has no race scoreboard")
        return self.race_summary_checkpoints(target["id"])


def emit(data: Any, as_json: bool) -> None:
    if as_json or isinstance(data, (dict, list)):
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(data)


def main() -> int:
    parser = argparse.ArgumentParser(description="AdWorld automation client")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--session-file", help="Session cache file. Defaults to .sessions/adworld_<host>.json")
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
    sub.add_parser("session")
    sub.add_parser("cache-info")

    p = sub.add_parser("competitions")
    p.add_argument("--page", type=int, default=1)
    p.add_argument("--per-page", type=int, default=10)
    p.add_argument("--category", type=int)
    p.add_argument("--search", default="")
    p.add_argument("--progress", type=int)
    p.add_argument("--public", action="store_true")

    p = sub.add_parser("competition")
    p.add_argument("--id", required=True)
    p.add_argument("--public", action="store_true")

    p = sub.add_parser("in-race")
    p.add_argument("--resource-id", action="append", dest="resource_ids")
    p.add_argument("--category", action="append", dest="categories", type=int)

    p = sub.add_parser("enter-race")
    p.add_argument("--race-id", required=True)
    p.add_argument("--category", required=True, type=int)

    p = sub.add_parser("race-info")
    p.add_argument("--race-id", required=True)

    p = sub.add_parser("race-base")
    p.add_argument("--race-id", required=True)

    p = sub.add_parser("race-summary")
    p.add_argument("--race-id", required=True)

    p = sub.add_parser("race-checkpoints")
    p.add_argument("--race-id", required=True)
    p.add_argument("--direction", default="")
    p.add_argument("--query", default="")

    p = sub.add_parser("race-checkpoint")
    p.add_argument("--race-id", required=True)
    p.add_argument("--checkpoint-id", required=True)

    p = sub.add_parser("race-download")
    p.add_argument("--race-id", required=True)
    p.add_argument("--checkpoint-id", required=True)
    p.add_argument("--outdir", required=True)

    p = sub.add_parser("race-submit")
    p.add_argument("--race-id", required=True)
    p.add_argument("--checkpoint-id", required=True)
    p.add_argument("--flag", required=True)

    p = sub.add_parser("practice-set")
    p.add_argument("--resource-id", required=True)

    p = sub.add_parser("practice-categories")
    p.add_argument("--practice-set-id", required=True)
    p.add_argument("--practice-type", required=True, type=int)

    p = sub.add_parser("theory-list")
    p.add_argument("--practice-set-id", required=True)
    p.add_argument("--pattern", default="")
    p.add_argument("--category-id", default="")
    p.add_argument("--solved", type=int)
    p.add_argument("--difficulty", type=int)

    p = sub.add_parser("operation-list")
    p.add_argument("--practice-set-id", required=True)
    p.add_argument("--pattern", default="")
    p.add_argument("--category-id", default="")
    p.add_argument("--solved", type=int)
    p.add_argument("--difficulty", type=int)

    p = sub.add_parser("operation")
    p.add_argument("--resource-id", required=True)

    p = sub.add_parser("download")
    p.add_argument("--resource-id", required=True)
    p.add_argument("--outdir", required=True)

    p = sub.add_parser("submit")
    p.add_argument("--resource-id", required=True)
    p.add_argument("--flag", required=True)
    p.add_argument("--again", action="store_true")

    args = parser.parse_args()
    if not args.session_file:
        args.session_file = str(AdWorldClient.default_session_file(args.base_url))

    client = AdWorldClient(args.base_url, timeout=args.timeout, verify=not args.insecure, debug=args.debug)
    client.load_session(args.session_file)

    try:
        if args.cmd == "probe":
            emit(client.probe(), args.json)
        elif args.cmd == "login":
            data = client.login(args.username, args.password)
            data["session_cache"] = client.save_session(args.session_file)
            emit(data, args.json)
        elif args.cmd == "me":
            data = client.current_auth()
            client.persist_current_session(args.session_file)
            emit(data, args.json)
        elif args.cmd == "session":
            emit(
                {
                    "session_file": args.session_file,
                    **client.cache_state(),
                },
                args.json,
            )
        elif args.cmd == "cache-info":
            emit({"session_file": args.session_file, **client.cache_state()}, args.json)
        elif args.cmd == "competitions":
            emit(client.competitions(args.page, args.per_page, args.category, args.search, args.progress, args.public), args.json)
        elif args.cmd == "competition":
            emit(client.competition(args.id, args.public), args.json)
        elif args.cmd == "in-race":
            resource_ids = args.resource_ids or []
            categories = args.categories or []
            races = [{"resource_id": rid, "category": categories[idx] if idx < len(categories) else None} for idx, rid in enumerate(resource_ids)]
            emit(client.query_in_race(races), args.json)
        elif args.cmd == "enter-race":
            emit(client.enter_race(args.race_id, args.category), args.json)
        elif args.cmd == "race-info":
            emit(client.race_info(args.race_id), args.json)
        elif args.cmd == "race-base":
            emit(client.race_base(args.race_id), args.json)
        elif args.cmd == "race-summary":
            emit(client.race_summary_checkpoints(args.race_id), args.json)
        elif args.cmd == "race-checkpoints":
            emit(client.race_checkpoints(args.race_id, args.direction, args.query), args.json)
        elif args.cmd == "race-checkpoint":
            emit(client.race_checkpoint_detail(args.race_id, args.checkpoint_id), args.json)
        elif args.cmd == "race-download":
            emit([asdict(item) for item in client.download_race_attachment(args.race_id, args.checkpoint_id, args.outdir)], args.json)
        elif args.cmd == "race-submit":
            emit(client.submit_race_flag(args.race_id, args.checkpoint_id, args.flag), args.json)
        elif args.cmd == "practice-set":
            emit(client.practice_set_detail(args.resource_id), args.json)
        elif args.cmd == "practice-categories":
            emit(client.practice_categories(args.practice_set_id, args.practice_type), args.json)
        elif args.cmd == "theory-list":
            emit(client.theory_list(args.practice_set_id, args.pattern, args.category_id, args.solved, args.difficulty), args.json)
        elif args.cmd == "operation-list":
            emit(client.operation_list(args.practice_set_id, args.pattern, args.category_id, args.solved, args.difficulty), args.json)
        elif args.cmd == "operation":
            emit(client.operation_detail(args.resource_id), args.json)
        elif args.cmd == "download":
            emit([asdict(item) for item in client.download_operation_attachment(args.resource_id, args.outdir)], args.json)
        elif args.cmd == "submit":
            emit(client.submit_flag(args.resource_id, args.flag, args.again), args.json)
        else:
            parser.error("unknown command")
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        body = exc.response.text[:1000] if exc.response is not None else ""
        print(f"[!] HTTP {status}: {body}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"[!] {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, unquote, unquote_to_bytes, urlparse

import requests

DEFAULT_TIMEOUT = 20
UA = "ctf-platform-manager-nssctf/0.1"
SESSION_DIR = Path(".sessions")

NSS_TYPE_NAMES: Dict[str, str] = {
    "1": "WEB",
    "2": "PWN",
    "3": "REVERSE",
    "4": "CRYPTO",
    "5": "MISC",
    "6": "MOBILE",
    "7": "ETH",
    "8": "IOT",
    "9": "AI",
    "10": "实战",
    "11": "靶场",
}

DEFAULT_PROBLEM_FILTERS: Dict[str, Any] = {
    "category": 0,
    "contest": "",
    "year": "",
    "source": 0,
    "name": "",
    "username": "",
    "type": 0,
    "docker": 0,
    "tag": [],
    "tagType": 0,
    "point": [1, 1000],
    "rate": [0, 5],
    "date": "",
    "state": "",
    "order": "point",
    "orderType": 0,
}


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
        self._problem_detail_cache: Dict[int, Dict[str, Any]] = {}

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
    def explain_code(code: Any, context: str | None = None) -> str:
        if context == "problem_flag_submit":
            return "Flag正确！" if code == 200 else "flag有误，请重新提交。"
        if context == "contest_flag_submit":
            return {
                200: "Flag正确！",
                203: "该题提交次数已达上限。",
                204: "您已经解决本题了。",
            }.get(code, "提交Flag失败。")
        if context == "contest_detail":
            return {
                201: "比赛不存在！",
                403: "您没有权限查看本场比赛！",
            }.get(code, f"比赛详情获取失败，状态码 {code}")
        mapping = {
            200: "成功",
            201: "未授权",
            202: "资源不存在",
            203: "参数校验失败",
            204: "禁止操作",
            205: "已达到限制",
            301: "请先进行实名认证",
            402: "请先登录",
            403: "权限不足",
        }
        return mapping.get(code, f"未识别状态码 {code}")

    def _result_from_response(self, resp: requests.Response, *, context: str | None = None) -> Dict[str, Any]:
        data = self._json(resp)
        if not isinstance(data, dict):
            raise NSSCTFError(f"Unexpected response shape from {resp.url}: {data!r}")
        code = data.get("code")
        result_data = data.get("data") if "data" in data else {}
        accepted = code == 200
        message = self.explain_code(code, context=context)
        if context == "contest_flag_submit":
            accepted = code == 200 and bool(result_data)
            if code == 200 and not accepted:
                message = "Flag不正确。"
        return {
            "code": code,
            "ok": accepted,
            "accepted": accepted,
            "message": message,
            "data": result_data,
            "raw": data,
        }

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
        data = self._json(resp)
        if not isinstance(data, dict):
            raise NSSCTFError(f"Unexpected response shape from {resp.url}: {data!r}")
        if data.get("code") == 200:
            return data.get("data") or {}
        return {
            "code": data.get("code"),
            "ok": False,
            "message": self.explain_code(data.get("code"), context="contest_detail"),
            "data": data.get("data") or {},
            "raw": data,
        }

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
        data = self._unwrap(resp).get("data") or []
        return self.enrich_problem_summaries(data) if isinstance(data, list) else []

    def problem_list(self, page: int = 1, page_size: int = 20, filters: Optional[Dict[str, Any]] = None, team_mode: bool = False) -> Dict[str, Any]:
        path = f"/api/problem/team/list/{page}/{page_size}/" if team_mode else f"/api/problem/v3/list/{page}/{page_size}/"
        request_filters = {**DEFAULT_PROBLEM_FILTERS, **(filters or {})}
        if "search" in request_filters:
            request_filters["name"] = request_filters.pop("search")
        resp = self._request("POST", path, json=request_filters)
        resp.raise_for_status()
        data = self._unwrap(resp).get("data") or {}
        if isinstance(data, dict) and isinstance(data.get("problems"), list):
            data = {**data, "problems": self.enrich_problem_summaries(data["problems"])}
        return data

    def problem_detail(self, problem_id: int) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/problem/v2/{problem_id}/")
        resp.raise_for_status()
        detail = self._normalize_problem(self._unwrap(resp).get("data") or {})
        self._problem_detail_cache[problem_id] = detail
        return detail

    @staticmethod
    def _normalize_problem(problem: Dict[str, Any]) -> Dict[str, Any]:
        normalized = dict(problem)
        type_id = normalized.get("type")
        type_name = NSS_TYPE_NAMES.get(str(type_id)) if type_id is not None else None
        if type_id is not None:
            normalized.setdefault("type_id", type_id)
        if normalized.get("category") is not None:
            normalized.setdefault("category_id", normalized.get("category"))
        if type_name:
            normalized["category"] = type_name
            normalized.setdefault("direction", type_name)
            normalized.setdefault("type_name", type_name)
        if "docker" in normalized:
            normalized.setdefault("has_target", bool(normalized["docker"]))
        if "annex" in normalized:
            normalized.setdefault("has_attachment", bool(normalized["annex"]))
        return normalized

    def enrich_problem_summaries(self, problems: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Add type and capability fields omitted by NSSCTF's paged list API."""
        rows = [dict(problem) for problem in problems if isinstance(problem, dict)]
        missing_ids = []
        for row in rows:
            problem_id = row.get("id") or row.get("pid")
            if isinstance(problem_id, int) and problem_id not in self._problem_detail_cache:
                missing_ids.append(problem_id)

        if missing_ids:
            with ThreadPoolExecutor(max_workers=min(8, len(missing_ids))) as executor:
                futures = {executor.submit(self.problem_detail, problem_id): problem_id for problem_id in missing_ids}
                for future in as_completed(futures):
                    try:
                        future.result()
                    except Exception as exc:
                        self.log("problem detail enrichment failed", futures[future], exc)

        enriched = []
        for row in rows:
            problem_id = row.get("id") or row.get("pid")
            detail = self._problem_detail_cache.get(problem_id, {}) if isinstance(problem_id, int) else {}
            enriched.append(self._normalize_problem({**detail, **row}))
        return enriched

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

    def open_problem_target(self, problem_id: int, type_id: int = 0) -> Dict[str, Any]:
        """Open a problem-bank dynamic target/container."""
        open_result = self.open_problem_attachment(problem_id, type_id=type_id)
        if open_result.get("code") not in {200, 203}:
            return {
                "problem_id": problem_id,
                "opened": False,
                "pending": False,
                "open_result": open_result,
                "addresses": [],
            }

        target_info: Dict[str, Any] = {}
        for attempt in range(16):
            target_info = self.problem_target_info(problem_id)
            if self._target_info_ready(target_info):
                break
            if attempt < 15:
                time.sleep(1)
        addresses = self._collect_target_addresses(target_info)
        opened = bool(addresses) or open_result.get("code") == 200 or target_info.get("code") == 200
        return {
            "problem_id": problem_id,
            "opened": opened,
            "pending": opened and not bool(addresses),
            "open_result": open_result,
            "target_info": target_info,
            "addresses": addresses,
        }

    def problem_target_info(self, problem_id: int) -> Dict[str, Any]:
        """Return NSSCTF problem-bank docker provisioning state and URL."""
        resp = self._request("GET", f"/api/problem/docker/{problem_id}/")
        resp.raise_for_status()
        data = self._json(resp)
        if not isinstance(data, dict):
            raise NSSCTFError(f"Unexpected target info response from {resp.url}: {data!r}")
        return data

    @staticmethod
    def _target_info_ready(target_info: Dict[str, Any]) -> bool:
        if target_info.get("code") != 200:
            return False
        data = target_info.get("data")
        if not isinstance(data, dict):
            return False
        state = data.get("state")
        return isinstance(data.get("url"), str) and bool(data["url"].strip()) and (not isinstance(state, (int, float)) or state >= 4)

    @staticmethod
    def _collect_target_addresses(*payloads: Any) -> List[str]:
        addresses: List[str] = []

        def add(value: Any) -> None:
            if isinstance(value, str) and value.strip() and value.strip() not in addresses:
                addresses.append(value.strip())

        def walk(value: Any) -> None:
            if isinstance(value, dict):
                for key in ("url", "entry", "address", "target", "endpoint"):
                    add(value.get(key))
                for child in value.values():
                    if isinstance(child, (dict, list)):
                        walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        for payload in payloads:
            walk(payload)
        return addresses

    def open_contest_target(self, contest_id: int, problem_id: int, type_id: int = 0) -> Dict[str, Any]:
        """Open a contest dynamic target/container.

        NSSCTF forks differ slightly. Try the contest-scoped endpoints first,
        then fall back to the global problem docker endpoint.
        """
        paths = [
            f"/api/contest/{contest_id}/problem/{problem_id}/docker/open/",
            f"/api/contest/problem/{contest_id}/{problem_id}/docker/open/",
            f"/api/contest/{contest_id}/docker/{problem_id}/open/",
        ]
        last_error: Exception | None = None
        for path in paths:
            try:
                resp = self._request("POST", path, json={"type": type_id})
                if resp.status_code == 404:
                    continue
                resp.raise_for_status()
                data = self._json(resp)
                if not isinstance(data, dict):
                    raise NSSCTFError(f"Unexpected open response from {resp.url}: {data!r}")
                return data
            except Exception as exc:
                last_error = exc
                self.log("contest target open failed", path, exc)
        try:
            return self.open_problem_target(problem_id, type_id=type_id)
        except Exception as exc:
            last_error = exc
        raise NSSCTFError(f"Contest target open failed: {last_error}")

    def close_problem_target(self, problem_id: int, type_id: int = 0) -> Dict[str, Any]:
        """Close a problem-bank dynamic target/container."""
        paths = [
            ("POST", f"/api/problem/docker/{problem_id}/close/", {}),
            ("DELETE", f"/api/problem/docker/{problem_id}/close/", {"json": {"type": type_id}}),
            ("POST", f"/api/problem/docker/{problem_id}/destroy/", {"json": {"type": type_id}}),
            ("DELETE", f"/api/problem/docker/{problem_id}/", {"json": {"type": type_id}}),
        ]
        last_error: Exception | None = None
        for method, path, kwargs in paths:
            try:
                resp = self._request(method, path, **kwargs)
                if resp.status_code == 404:
                    continue
                resp.raise_for_status()
                data = self._json(resp)
                if not isinstance(data, dict):
                    raise NSSCTFError(f"Unexpected close response from {resp.url}: {data!r}")
                return {"problem_id": problem_id, "closed": data.get("code") == 200, "close_result": data, "addresses": []}
            except Exception as exc:
                last_error = exc
                self.log("problem target close failed", method, path, exc)
        raise NSSCTFError(f"Problem target close failed: {last_error}")

    def close_contest_target(self, contest_id: int, problem_id: int, type_id: int = 0) -> Dict[str, Any]:
        """Close a contest dynamic target/container."""
        paths = [
            ("POST", f"/api/contest/{contest_id}/problem/{problem_id}/docker/close/", {"json": {"type": type_id}}),
            ("DELETE", f"/api/contest/{contest_id}/problem/{problem_id}/docker/close/", {"json": {"type": type_id}}),
            ("POST", f"/api/contest/problem/{contest_id}/{problem_id}/docker/close/", {"json": {"type": type_id}}),
            ("DELETE", f"/api/contest/problem/{contest_id}/{problem_id}/docker/close/", {"json": {"type": type_id}}),
            ("POST", f"/api/contest/{contest_id}/docker/{problem_id}/close/", {"json": {"type": type_id}}),
            ("DELETE", f"/api/contest/{contest_id}/docker/{problem_id}/close/", {"json": {"type": type_id}}),
        ]
        last_error: Exception | None = None
        for method, path, kwargs in paths:
            try:
                resp = self._request(method, path, **kwargs)
                if resp.status_code == 404:
                    continue
                resp.raise_for_status()
                data = self._json(resp)
                if not isinstance(data, dict):
                    raise NSSCTFError(f"Unexpected close response from {resp.url}: {data!r}")
                return data
            except Exception as exc:
                last_error = exc
                self.log("contest target close failed", method, path, exc)
        try:
            return self.close_problem_target(problem_id, type_id=type_id)
        except Exception as exc:
            last_error = exc
        raise NSSCTFError(f"Contest target close failed: {last_error}")

    @staticmethod
    def _decode_filename_value(value: str) -> str:
        text = value.strip().strip('"').strip("'")
        if not text:
            return ""
        if "''" in text:
            charset, encoded = text.split("''", 1)
            try:
                return unquote_to_bytes(encoded).decode(charset or "utf-8").strip()
            except Exception:
                text = encoded
        text = unquote(text).strip()
        try:
            # requests follows RFC 7230 and decodes headers as latin1.  NSSCTF
            # file services may put raw UTF-8 bytes in filename=, which appears
            # as mojibake such as "éä»¶.py" unless repaired here.
            repaired = text.encode("latin1").decode("utf-8").strip()
            if repaired:
                return repaired
        except UnicodeError:
            pass
        return text

    @classmethod
    def _filename_from_content_disposition(cls, value: str) -> Optional[str]:
        if not value:
            return None
        parts = [part.strip() for part in value.split(";")]
        params: Dict[str, str] = {}
        for part in parts[1:]:
            if "=" not in part:
                continue
            key, raw = part.split("=", 1)
            params[key.strip().lower()] = raw.strip()
        for key in ("filename*", "filename"):
            if key in params:
                name = cls._decode_filename_value(params[key])
                if name:
                    return Path(name).name
        return None

    @classmethod
    def _filename_from_url(cls, url: str) -> Optional[str]:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        for key in ("response-content-disposition", "content-disposition"):
            for value in query.get(key, []):
                name = cls._filename_from_content_disposition(value)
                if name:
                    return name
        path_name = cls._decode_filename_value(Path(parsed.path).name)
        return path_name or None

    @classmethod
    def _filename_from_response(cls, resp: requests.Response) -> Optional[str]:
        return cls._filename_from_content_disposition(resp.headers.get("content-disposition", "")) or cls._filename_from_url(resp.url)

    def _download_external_url(self, external_url: str) -> requests.Response:
        real = self._request("GET", external_url, stream=True)
        real.raise_for_status()
        return real

    def _resolve_json_annex_response(self, resp: requests.Response) -> Optional[requests.Response]:
        ctype = resp.headers.get("content-type", "")
        if "json" not in ctype:
            return resp
        data = self._json(resp)
        if not isinstance(data, dict):
            raise NSSCTFError(f"Unexpected annex response shape from {resp.url}: {data!r}")
        code = data.get("code")
        external_url = data.get("data")
        if code == 200 and isinstance(external_url, str) and external_url.startswith(("http://", "https://")):
            return self._download_external_url(external_url)
        if code == 200:
            raise NSSCTFError(f"Annex response missing downloadable URL: {data}")
        if code == 202:
            raise NSSCTFError(f"Annex unavailable: contest ended code=202: {data}")
        # code=203/data=null can appear before the required open/preflight fully
        # unlocks the attachment. Return None so callers can retry after open.
        if code == 203:
            return None
        raise NSSCTFError(f"Annex unavailable code={code}: {data}")

    def _resolve_problem_annex_download(self, problem_id: int) -> requests.Response:
        last_data: Any = None
        for attempt in range(6):
            # 尝试补齐前置 open 步骤；失败时不立刻终止，继续探测 annex 接口返回。
            try:
                open_data = self.open_problem_attachment(problem_id)
                self.log("problem open", problem_id, "attempt", attempt + 1, "->", open_data)
                last_data = open_data
            except Exception as exc:
                self.log("problem open failed", problem_id, "attempt", attempt + 1, exc)

            resp = self.problem_annex(problem_id)
            resolved = self._resolve_json_annex_response(resp)
            if resolved is not None:
                return resolved
            try:
                last_data = self._json(resp)
            except Exception:
                pass
            time.sleep(0.6 + attempt * 0.25)

        raise NSSCTFError(f"Problem annex unavailable after retry: {last_data}")

    def _resolve_problem_annex_download_legacy(self, problem_id: int) -> requests.Response:
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
            filename = self._filename_from_response(resp)
            if not filename and "json" in ctype:
                filename = f"problem_{problem_id}_annex.json"
            elif not filename:
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
        return self._result_from_response(resp, context="problem_flag_submit")

    def contest_problem_categories(self, contest_id: int) -> Dict[str, Any]:
        resp = self._request("GET", f"/api/contest/{contest_id}/problem/category/")
        resp.raise_for_status()
        return self._unwrap(resp).get("data") or {}

    def _contest_category_names(self, cats: Dict[str, Any]) -> Dict[str, str]:
        """Build per-contest category id -> display name mapping.

        /problem/category/ returns the type ids enabled for the current contest.
        The list is contest-specific, so callers must not treat a problem's
        contest_category as a fixed 0-based position.  Prefer names supplied by
        the response, then fall back to NSSCTF's global 1-based type ids.
        """
        mapping: Dict[str, str] = {}

        def add(key: Any, value: Any) -> None:
            if key is None or value is None:
                return
            name = str(value).strip()
            if name:
                mapping[str(key)] = name

        for field in ("category", "categories", "items"):
            values = cats.get(field)
            if isinstance(values, list):
                for entry in values:
                    if isinstance(entry, dict):
                        add(entry.get("id") or entry.get("type") or entry.get("value") or entry.get("key"), entry.get("name") or entry.get("title") or entry.get("label"))

        types = cats.get("type") or cats.get("types") or []
        names = cats.get("name") or cats.get("names") or cats.get("label") or cats.get("labels") or []
        if not isinstance(names, list):
            names = []
        if isinstance(types, list):
            for index, typ in enumerate(types):
                explicit = names[index] if index < len(names) else None
                add(typ, explicit or NSS_TYPE_NAMES.get(str(typ)) or (typ if isinstance(typ, str) and not typ.isdigit() else None))

        return mapping

    def contest_problem_list(self, contest_id: int) -> Dict[str, Any]:
        """Return all visible contest problems grouped and flattened.

        NSSCTF exposes contest problem lists by category id at
        /api/contest/<cid>/problem/<type>/. The same path with a real problem id
        returns detail, so the category ids are first discovered through
        /problem/category/.
        """
        cats = self.contest_problem_categories(contest_id)
        types = cats.get("type") or []
        category_names = self._contest_category_names(cats)
        grouped: Dict[str, Any] = {}
        problems: List[Dict[str, Any]] = []
        for typ in types:
            type_key = str(typ)
            resp = self._request("GET", f"/api/contest/{contest_id}/problem/{typ}/")
            resp.raise_for_status()
            data = self._unwrap(resp).get("data") or []
            grouped[type_key] = data
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict):
                        category_name = category_names.get(type_key) or NSS_TYPE_NAMES.get(type_key)
                        problems.append({
                            **item,
                            "contest_category": category_name or typ,
                            "contest_category_id": typ,
                            "category": category_name or item.get("category"),
                        })
        return {"contest_id": contest_id, "categories": cats, "category_names": category_names, "grouped": grouped, "problems": problems, "total": len(problems)}

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

    def _resolve_contest_annex_download(self, contest_id: int, problem_id: int) -> requests.Response:
        last_data: Any = None
        for attempt in range(6):
            # Some NSSCTF contest annex endpoints need the challenge detail to be
            # touched before the backend prepares the attachment URL. code=202 is
            # handled as a hard "contest ended" error in _resolve_json_annex_response.
            try:
                detail = self.challenge_detail(contest_id, problem_id)
                self.log("contest challenge detail", contest_id, problem_id, "attempt", attempt + 1, "->", detail)
                last_data = detail
            except Exception as exc:
                self.log("contest challenge detail failed", contest_id, problem_id, "attempt", attempt + 1, exc)

            resp = self.challenge_annex(contest_id, problem_id)
            resolved = self._resolve_json_annex_response(resp)
            if resolved is not None:
                return resolved
            try:
                last_data = self._json(resp)
            except Exception:
                pass
            time.sleep(0.6 + attempt * 0.25)

        raise NSSCTFError(f"Contest annex unavailable after retry: {last_data}")

    def download_annex(self, contest_id: int, problem_id: int, outdir: str, filename: Optional[str] = None) -> List[DownloadedFile]:
        resp = self._resolve_contest_annex_download(contest_id, problem_id)
        out = Path(outdir)
        out.mkdir(parents=True, exist_ok=True)
        ctype = resp.headers.get("content-type", "")
        if not filename:
            filename = self._filename_from_response(resp)
            if not filename and "json" in ctype:
                filename = f"contest_{contest_id}_problem_{problem_id}_annex.json"
            elif not filename:
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
        return self._result_from_response(resp, context="contest_flag_submit")


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

from __future__ import annotations

from typing import Any
from urllib.parse import urljoin

from ..base import CTFPlatformClient
from ..models import Credentials, PlatformConfig, to_plain
from ..normalize import annotate_contest_item, annotate_contest_listing, contest_id_of, merge_contest_listings
from ..registry import register_platform

DEFAULT_BASE_URL = "https://adworld.xctf.org.cn"


@register_platform("xctf", "adworld")
class AdWorldPlatform(CTFPlatformClient):
    platform = "adworld"
    display_name = "攻防世界 / AdWorld"

    def __init__(self, config: PlatformConfig):
        super().__init__(config)
        from ..vendor.adworld_client import AdWorldClient
        self._client_cls = AdWorldClient
        base_url = config.base_url or DEFAULT_BASE_URL
        self.config.base_url = base_url
        self.client = self._client_cls(base_url, timeout=config.timeout, verify=config.verify, debug=config.debug)
        if config.token:
            self._apply_token(config.token)

    def _apply_token(self, token: str) -> dict[str, Any]:
        self.client.token = token
        self.client._refresh_common_headers()
        return {"success": True, "method": "token", "header": "Authorization", "cookie": "cr_jwttoken"}

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
        return to_plain(self.client.load_session(self._session_path(path)))

    def save_session(self, path: str | None = None) -> dict[str, Any]:
        return to_plain(self.client.save_session(self._session_path(path)))

    def current_user(self) -> dict[str, Any]:
        return to_plain(self.client.current_auth())

    @staticmethod
    def _entry_url(entry: dict[str, Any]) -> str:
        race_url = entry.get("race_url")
        if isinstance(race_url, str) and race_url.strip():
            return race_url.strip()
        race = entry.get("race")
        if isinstance(race, dict):
            raw = race.get("raw") if isinstance(race.get("raw"), dict) else {}
            for key in ("race_url", "url", "href"):
                value = raw.get(key) or race.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return ""

    def _full_entry_url(self, entry: dict[str, Any]) -> str:
        value = self._entry_url(entry)
        if not value:
            return ""
        return urljoin(self.config.base_url.rstrip("/") + "/", value)

    def _compact_entry(self, entry: dict[str, Any]) -> dict[str, Any]:
        compact = {k: entry.get(k) for k in ("query", "kind", "target_id", "category", "event_id", "event_name", "race_url") if k in entry}
        play_url = self._full_entry_url(entry)
        if play_url:
            compact["play_url"] = play_url
        race = entry.get("race")
        if isinstance(race, dict):
            raw = race.get("raw") if isinstance(race.get("raw"), dict) else {}
            compact["race"] = {
                "resource_id": race.get("resource_id"),
                "category": race.get("category"),
                "race_id": raw.get("race_id"),
                "race_url": raw.get("race_url") or race.get("race_url"),
                "name": raw.get("name") or raw.get("short_name"),
                "start_time": raw.get("start_time"),
                "end_time": raw.get("end_time"),
            }
        return compact

    def _annotate_contest(self, item: dict[str, Any]) -> dict[str, Any]:
        contest_id = contest_id_of(item)
        extra: dict[str, Any] = {}
        if contest_id:
            try:
                entry = self.client.contest_entry(contest_id)
                play_url = self._full_entry_url(entry)
                extra["entry"] = self._compact_entry(entry)
                if play_url:
                    extra["play_url"] = play_url
                if entry.get("kind"):
                    extra["playable_kind"] = entry.get("kind")
                if entry.get("target_id"):
                    extra["playable_id"] = entry.get("target_id")
                if entry.get("category") is not None:
                    extra["category"] = entry.get("category")
            except Exception as exc:
                # Listing must stay useful even when a stale/ended event cannot
                # resolve to a playable race.  Do not keyword-search fallback.
                extra["entry_error"] = str(exc)
        return annotate_contest_item(item, self.platform, command_id=contest_id, extra=extra)

    def list_contests(self, page: int = 1, page_size: int = 50, search: str | None = None, public: bool | None = None) -> Any:
        # Default behavior returns all visible contests by merging authenticated and public listings.
        if public is True:
            data = self.client.competitions(page=page, per_page=page_size, search=search or "", public=True)
        elif public is False:
            data = self.client.competitions(page=page, per_page=page_size, search=search or "", public=False)
        else:
            private_data: Any = {}
            public_data: Any = {}
            try:
                private_data = self.client.competitions(page=page, per_page=page_size, search=search or "", public=False)
            except Exception:
                private_data = {}
            try:
                public_data = self.client.competitions(page=page, per_page=page_size, search=search or "", public=True)
            except Exception:
                public_data = {}
            data = merge_contest_listings(private_data, public_data)
        listing = annotate_contest_listing(data, self.platform, item_annotator=self._annotate_contest)
        if isinstance(listing, dict):
            for key in ("items", "list", "contests", "competitions", "games", "events", "data", "results", "rows"):
                items = listing.get(key)
                if isinstance(items, list):
                    playable = [
                        item for item in items
                        if isinstance(item, dict) and item.get("playable_id") and item.get("play_url") and not item.get("entry_error")
                    ]
                    listing = {**listing, key: playable, "items": playable, "total": len(playable), "filtered_unplayable": len(items) - len(playable)}
                    break
        return to_plain(listing)

    def get_contest(self, contest_id: str | int) -> Any:
        key = str(contest_id)
        detail: Any = {}
        try:
            detail = self.client.competition(key, public=False)
        except Exception:
            try:
                detail = self.client.competition(key, public=True)
            except Exception:
                pass
        entry = self.client.contest_entry(key)
        if isinstance(detail, dict) and detail:
            annotated = self._annotate_contest(detail)
            return to_plain({**annotated, "entry": entry})
        return to_plain(annotate_contest_item({"id": key}, self.platform, command_id=key, extra={"entry": entry}))

    def join_contest(self, contest_id: str | int, team_id: str | int | None = None, invite_code: str | None = None) -> Any:
        return to_plain(self.client.enter_contest(str(contest_id)))

    def list_challenges(self, contest_id: str | int | None = None, page: int = 1, page_size: int = 50, search: str | None = None) -> Any:
        if contest_id is None:
            raise ValueError("AdWorld list_challenges requires contest_id")
        return to_plain(self.client.contest_challenges(str(contest_id), page=page, page_size=page_size, search=search or ""))

    def get_challenge(self, challenge_id: str | int, contest_id: str | int | None = None) -> Any:
        return to_plain(self.client.contest_challenge_detail(str(contest_id) if contest_id is not None else None, str(challenge_id)))

    def download_attachment(self, challenge_id: str | int, outdir: str, contest_id: str | int | None = None) -> list[Any]:
        return to_plain(self.client.contest_download_attachment(str(contest_id) if contest_id is not None else None, str(challenge_id), outdir))

    def submit_flag(self, challenge_id: str | int, flag: str, contest_id: str | int | None = None) -> Any:
        return to_plain(self.client.contest_submit_flag(str(contest_id) if contest_id is not None else None, str(challenge_id), flag))

    def start_target(self, challenge_id: str | int, contest_id: str | int | None = None) -> Any:
        return to_plain(self.client.contest_start_target(str(contest_id) if contest_id is not None else None, str(challenge_id)))

    def close_target(self, challenge_id: str | int, contest_id: str | int | None = None) -> Any:
        return to_plain(self.client.contest_close_target(str(contest_id) if contest_id is not None else None, str(challenge_id)))

    def scoreboard(self, contest_id: str | int | None = None) -> Any:
        if contest_id is None:
            raise ValueError("AdWorld scoreboard requires contest_id")
        return to_plain(self.client.contest_scoreboard(str(contest_id)))

    def raw_client(self) -> Any:
        return self.client

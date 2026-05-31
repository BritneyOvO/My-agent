from __future__ import annotations

from typing import Any

from ..base import CTFPlatformClient
from ..models import Credentials, PlatformConfig, to_plain
from ..normalize import annotate_contest_listing
from ..registry import register_platform

DEFAULT_BASE_URL = "https://www.nssctf.cn"


@register_platform("nss", "nssctf-problem", "nss-problem")
class NSSCTFPlatform(CTFPlatformClient):
    platform = "nssctf"
    display_name = "NSSCTF"

    def __init__(self, config: PlatformConfig):
        super().__init__(config)
        from ..vendor.nssctf_client import NSSCTFClient
        self._client_cls = NSSCTFClient
        base_url = config.base_url or DEFAULT_BASE_URL
        self.config.base_url = base_url
        self.client = self._client_cls(base_url, timeout=config.timeout, verify=config.verify, debug=config.debug)
        self._token: str | None = None
        if config.token:
            self._apply_token(config.token)

    def _apply_token(self, token: str) -> dict[str, Any]:
        self._token = token
        # NSSCTF exposes a 32-byte API token in /api/user/info/ and expects it
        # back as the `token` cookie. Keep the cookie/header distinction inside
        # the adapter; callers only provide a generic token.
        raw = token.split(" ", 1)[1] if token.lower().startswith(("bearer ", "token ", "jwt ")) else token
        self.client.session.cookies.set("token", raw)
        self.client.session.headers["Authorization"] = token if token.lower().startswith(("bearer ", "token ", "jwt ")) else f"Bearer {raw}"
        return {"success": True, "method": "token"}

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
        result = self.client.login(username, password, remember=credentials.remember)
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
        return to_plain(self.client.current_user())

    def list_contests(self, page: int = 1, page_size: int = 50, search: str | None = None) -> Any:
        filters = {"search": search} if search else None
        return to_plain(annotate_contest_listing(self.client.list_contests(page=page, filters=filters), self.platform))

    def get_contest(self, contest_id: str | int) -> Any:
        return to_plain(self.client.contest_info(int(contest_id)))

    def join_contest(self, contest_id: str | int, team_id: str | int | None = None, invite_code: str | None = None) -> Any:
        payload = {}
        if team_id is not None:
            payload["team_id"] = team_id
        if invite_code:
            payload["invite_code"] = invite_code
        return to_plain(self.client.contest_register(int(contest_id), payload=payload or None))

    def list_challenges(self, contest_id: str | int | None = None, page: int = 1, page_size: int = 50, search: str | None = None) -> Any:
        # Internal namespace split:
        #   contest_id=None => problem bank
        #   contest_id set  => contest challenge list embedded in contest info
        if contest_id is None:
            filters = {"search": search} if search else None
            data = self.client.problem_list(page=page, page_size=page_size, filters=filters)
            problems = data.get("problems") if isinstance(data, dict) else None
            # Real NSSCTF deployments can return an empty default list while the
            # public recent endpoint is populated. Keep that platform quirk here
            # instead of leaking filters/modes to the upper layer.
            if page == 1 and not search and isinstance(problems, list) and not problems:
                recent = self.client.problem_recent()
                return to_plain({"problems": recent, "total": len(recent), "source": "recent_fallback"})
            return to_plain(data)
        return to_plain(self.client.contest_problem_list(int(contest_id)))

    def get_challenge(self, challenge_id: str | int, contest_id: str | int | None = None) -> Any:
        if contest_id is None:
            return to_plain(self.client.problem_detail(int(challenge_id)))
        detail = self.client.challenge_detail(int(contest_id), int(challenge_id))
        # Some public NSSCTF contests return an empty object from the detail
        # endpoint while the category list contains the visible challenge data.
        if not detail:
            listing = self.client.contest_problem_list(int(contest_id))
            for item in listing.get("problems") or []:
                if str(item.get("id") or item.get("pid") or item.get("problem_id")) == str(challenge_id):
                    detail = item
                    break
        return to_plain(detail)

    def download_attachment(self, challenge_id: str | int, outdir: str, contest_id: str | int | None = None) -> list[Any]:
        if contest_id is None:
            return to_plain(self.client.download_problem_annex(int(challenge_id), outdir))
        return to_plain(self.client.download_annex(int(contest_id), int(challenge_id), outdir))

    def submit_flag(self, challenge_id: str | int, flag: str, contest_id: str | int | None = None) -> Any:
        if contest_id is None:
            return to_plain(self.client.submit_problem_flag(int(challenge_id), flag))
        return to_plain(self.client.submit_flag(int(contest_id), int(challenge_id), flag))

    def scoreboard(self, contest_id: str | int | None = None) -> Any:
        if contest_id is None:
            raise ValueError("NSSCTF scoreboard requires contest_id")
        return to_plain(self.client.contest_rank(int(contest_id), page=1))

    def raw_client(self) -> Any:
        return self.client

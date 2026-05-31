from __future__ import annotations

from typing import Any

from ..base import CTFPlatformClient
from ..models import Credentials, PlatformConfig, to_plain
from ..normalize import annotate_contest_listing
from ..registry import register_platform


@register_platform("gz")
class GZCTFPlatform(CTFPlatformClient):
    platform = "gzctf"
    display_name = "GZCTF"

    def __init__(self, config: PlatformConfig):
        super().__init__(config)
        if not config.base_url:
            raise ValueError("GZCTF requires config.base_url")
        from ..vendor.gzctf_client import GZCTFClient
        self._client_cls = GZCTFClient
        self.client = self._client_cls(config.base_url, token=config.token, timeout=config.timeout, verify=config.verify, debug=config.debug)

    def _session_path(self, path: str | None = None) -> str:
        return path or self.config.session_file or str(self._client_cls.default_session_file(self.config.base_url))

    def probe(self) -> dict[str, Any]:
        return to_plain(self.client.probe())

    def login(self, credentials: Credentials) -> dict[str, Any]:
        if credentials.token:
            self.client.set_token(credentials.token)
            saved = self.save_session(self._session_path())
            return to_plain({"login": {"success": True, "method": "token"}, "session_cache": saved})
        username, password = credentials.require_password()
        result = self.client.login(
            username,
            password,
            remember_me=credentials.remember,
            captcha_token=credentials.captcha_token,
        )
        saved = self.save_session(self._session_path())
        return to_plain({"login": result, "session_cache": saved})

    def load_session(self, path: str | None = None) -> dict[str, Any]:
        return to_plain(self.client.load_session(self._session_path(path)))

    def save_session(self, path: str | None = None) -> dict[str, Any]:
        return to_plain(self.client.save_session(self._session_path(path)))

    def current_user(self) -> dict[str, Any]:
        return to_plain(self.client._verify_login())

    def list_contests(self, page: int = 1, page_size: int = 50, search: str | None = None) -> Any:
        data = self.client.list_games(count=page_size, skip=max(page - 1, 0) * page_size)
        if search and isinstance(data, dict):
            needle = search.lower()
            items = data.get("items") or data.get("games") or data.get("data")
            if isinstance(items, list):
                filtered = [g for g in items if needle in str(g).lower()]
                data = {**data, "items": filtered}
        return to_plain(annotate_contest_listing(data, self.platform))

    def get_contest(self, contest_id: str | int) -> Any:
        # Joined games expose richer challenge metadata; fall back to public info.
        try:
            return to_plain(self.client.get_game_details(int(contest_id)))
        except Exception:
            return to_plain(self.client.get_game(int(contest_id)))

    def _default_team_id(self) -> int | None:
        try:
            teams = self.client.list_teams()
        except Exception:
            return None
        if not teams:
            return None
        for team in teams:
            tid = team.get("id") or team.get("teamId") or team.get("team_id")
            if tid is not None:
                return int(tid)
        return None

    def join_contest(self, contest_id: str | int, team_id: str | int | None = None, invite_code: str | None = None) -> Any:
        tid = int(team_id) if team_id is not None else self._default_team_id()
        return to_plain(self.client.join_game(int(contest_id), team_id=tid, invite_code=invite_code))

    def list_challenges(self, contest_id: str | int | None = None, page: int = 1, page_size: int = 50, search: str | None = None) -> Any:
        if contest_id is None:
            raise ValueError("GZCTF list_challenges requires contest_id")
        data = self.client.get_game_details(int(contest_id))
        # Do not force a shape: forks differ. Filter shallow challenge arrays when obvious.
        if search:
            needle = search.lower()
            for key in ("challenges", "Challenges", "instances"):
                if isinstance(data, dict) and isinstance(data.get(key), list):
                    data = {**data, key: [x for x in data[key] if needle in str(x).lower()]}
        return to_plain(data)

    def get_challenge(self, challenge_id: str | int, contest_id: str | int | None = None) -> Any:
        if contest_id is None:
            raise ValueError("GZCTF get_challenge requires contest_id")
        return to_plain(self.client.get_challenge(int(contest_id), int(challenge_id)))

    def download_attachment(self, challenge_id: str | int, outdir: str, contest_id: str | int | None = None) -> list[Any]:
        if contest_id is None:
            raise ValueError("GZCTF download_attachment requires contest_id")
        return to_plain(self.client.download_challenge_attachments(int(contest_id), int(challenge_id), outdir))

    def submit_flag(self, challenge_id: str | int, flag: str, contest_id: str | int | None = None) -> Any:
        if contest_id is None:
            raise ValueError("GZCTF submit_flag requires contest_id")
        return to_plain(self.client.submit_flag(int(contest_id), int(challenge_id), flag))

    def scoreboard(self, contest_id: str | int | None = None) -> Any:
        raise self.unsupported("scoreboard", "not implemented by bundled GZCTF client")

    def raw_client(self) -> Any:
        return self.client

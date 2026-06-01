from __future__ import annotations

from pathlib import Path
from typing import Any

from ..base import CTFPlatformClient
from ..models import Credentials, PlatformConfig, to_plain
from ..normalize import annotate_contest_item, annotate_contest_listing
from ..registry import register_platform


@register_platform("ctf+", "ctfplus")
class CTFPlusPlatform(CTFPlatformClient):
    platform = "ctfplus"
    display_name = "CTFPlus"

    def __init__(self, config: PlatformConfig):
        super().__init__(config)
        from ..vendor import ctfplus_client as ctfplus_mod
        self.mod = ctfplus_mod
        self._main_cls = self.mod.CTFPlusMainClient
        self._play_cls = self.mod.CTFPlusPlayClient
        self.main = self._main_cls()
        if config.token:
            self._apply_token(config.token)

    def _apply_token(self, token: str) -> dict[str, Any]:
        # CTFPlus main-site token maps to Authorization. If a deployment uses the
        # same token as a play-node cookie, _prepare_play also tries it as cookie.
        self.main.main_token = token
        self.main.s.headers["Authorization"] = token
        return {"success": True, "method": "token", "header": "Authorization"}

    def _session_path(self, path: str | None = None) -> str:
        return path or self.config.session_file or str(self._main_cls.default_session_file())

    def probe(self) -> dict[str, Any]:
        out: dict[str, Any] = {"main_origin": self.mod.MAIN_ORIGIN, "main_api": self.mod.MAIN_API}
        try:
            out["me"] = self.main.get_me()
            out["authenticated"] = True
        except Exception as exc:
            out["authenticated"] = False
            out["me_error"] = str(exc)
        return to_plain(out)

    def login(self, credentials: Credentials) -> dict[str, Any]:
        if credentials.token:
            result = self._apply_token(credentials.token)
            saved = self.save_session(self._session_path())
            return to_plain({"login": result, "session_cache": saved})
        username, password = credentials.require_password()
        result = self.main.login(username, password)
        saved = self.save_session(self._session_path())
        me = None
        try:
            me = self.main.get_me()
        except Exception:
            pass
        return to_plain({"login": result, "me": me, "session_cache": saved})

    def load_session(self, path: str | None = None) -> dict[str, Any]:
        return to_plain(self.main.load_session(self._session_path(path)))

    def save_session(self, path: str | None = None) -> dict[str, Any]:
        return to_plain(self.main.save_session(self._session_path(path)))

    def current_user(self) -> dict[str, Any]:
        return to_plain(self.main.get_me())

    def list_contests(self, page: int = 1, page_size: int = 50, search: str | None = None, public: bool | None = None) -> Any:
        data = self.main.list_joined_competitions(page=page, size=page_size)
        if search:
            needle = search.lower()
            comps = data.get("competitions") if isinstance(data, dict) else None
            if isinstance(comps, list):
                data = {**data, "competitions": [c for c in comps if needle in str(c).lower()]}
        def annotate(item: dict[str, Any]) -> dict[str, Any]:
            contest_id = item.get("shortName") or item.get("key") or item.get("id")
            return annotate_contest_item(item, self.platform, command_id=contest_id)

        return to_plain(annotate_contest_listing(data, self.platform, item_annotator=annotate))

    def get_contest(self, contest_id: str | int) -> Any:
        return to_plain(self.main.competition_overview(str(contest_id)))

    def join_contest(self, contest_id: str | int, team_id: str | int | None = None, invite_code: str | None = None) -> Any:
        raise self.unsupported("join_contest", "CTFPlus adapter currently exposes already-joined competitions")

    def _play_session_path(self, play_origin: str) -> str:
        return str(self.config.get("play_session_file") or self._play_cls.default_session_file(play_origin))

    def _prepare_play(self, competition_key: str):
        overview = self.main.competition_overview(str(competition_key))
        competition = overview.get("detail", {}).get("competition") or {}
        play_origin = (competition.get("address") or "").strip()
        if not play_origin:
            raise ValueError("CTFPlus competition has no play node address")

        play = self._play_cls(play_origin)
        auth_mode = "unknown"
        play_session_file = self._play_session_path(play_origin)

        if self.config.token:
            # Token is the only public auth primitive. For play nodes that use a
            # cookie-like token, try it as Cookie header internally.
            play.set_cookie_header(self.config.token)
            auth_mode = "token_cookie"
        if Path(play_session_file).exists():
            play.load_session(play_session_file)
            auth_mode = "cached_play_session"

        try:
            play.get_base()
            return overview, play, play_session_file, auth_mode
        except Exception:
            pass

        tmp_token = self.main.generate_tmp_login_token()
        play.bootstrap_with_tmp_token(tmp_token, verifier=lambda token: self.main.probe_tmp_login_token(token, auth_type=1))
        play.save_session(play_session_file)
        return overview, play, play_session_file, "tmp_bootstrap"

    def list_challenges(self, contest_id: str | int | None = None, page: int = 1, page_size: int = 50, search: str | None = None) -> Any:
        if contest_id is None:
            raise ValueError("CTFPlus list_challenges requires contest_id")
        overview, play, play_session_file, auth_mode = self._prepare_play(str(contest_id))
        data = play.list_challenges()
        # Filtering/pagination stays platform-local and best-effort because play
        # node response shapes vary between deployments.
        if search and isinstance(data, dict):
            needle = search.lower()
            for key in ("challenges", "challenge", "list", "items"):
                if isinstance(data.get(key), list):
                    data = {**data, key: [x for x in data[key] if needle in str(x).lower()]}
        return to_plain({"competition": overview.get("summary"), "play_origin": play.play_origin, "play_session_file": play_session_file, "auth_mode": auth_mode, "result": data})

    def get_challenge(self, challenge_id: str | int, contest_id: str | int | None = None) -> Any:
        if contest_id is None:
            raise ValueError("CTFPlus get_challenge requires contest_id")
        overview, play, play_session_file, auth_mode = self._prepare_play(str(contest_id))
        detail = play.challenge_view(play.get_challenge_detail(str(challenge_id)))
        return to_plain({"competition": overview.get("summary"), "play_origin": play.play_origin, "play_session_file": play_session_file, "auth_mode": auth_mode, "challenge": detail})

    def download_attachment(self, challenge_id: str | int, outdir: str, contest_id: str | int | None = None) -> list[Any]:
        if contest_id is None:
            raise ValueError("CTFPlus download_attachment requires contest_id")
        _overview, play, _play_session_file, _auth_mode = self._prepare_play(str(contest_id))
        detail = play.challenge_view(play.get_challenge_detail(str(challenge_id)))
        attachments = detail.get("attachments_normalized") or []
        out = self.mod.ensure_dir(outdir)
        downloaded = []
        for item in attachments:
            path = out / self.mod.safe_filename(item.get("name") or "attachment")
            self.mod.download_file(play.s, item["url"], path)
            downloaded.append({**item, "path": str(path)})
        return to_plain(downloaded)

    def submit_flag(self, challenge_id: str | int, flag: str, contest_id: str | int | None = None) -> Any:
        if contest_id is None:
            raise ValueError("CTFPlus submit_flag requires contest_id")
        overview, play, play_session_file, auth_mode = self._prepare_play(str(contest_id))
        result = play.submit_flag(str(challenge_id), flag)
        return to_plain({"competition": overview.get("summary"), "play_origin": play.play_origin, "play_session_file": play_session_file, "auth_mode": auth_mode, "submit_result": result})

    def scoreboard(self, contest_id: str | int | None = None) -> Any:
        raise self.unsupported("scoreboard", "not implemented by bundled CTFPlus client")

    def raw_client(self) -> Any:
        return self.main

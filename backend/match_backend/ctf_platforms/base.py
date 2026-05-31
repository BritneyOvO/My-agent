from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from .exceptions import UnsupportedOperation
from .models import Credentials, PlatformConfig


class CTFPlatformClient(ABC):
    """Java-like platform interface.

    上层只依赖这组稳定方法；任何平台内部概念（race_id、practice_set、
    problem_bank、challenge_type、details 等）必须在 adapter/vendor 内部消化，
    不允许泄漏给调用者。
    """

    platform: str = "abstract"
    display_name: str = "Abstract CTF Platform"

    def __init__(self, config: PlatformConfig):
        self.config = config

    @abstractmethod
    def probe(self) -> dict[str, Any]:
        """Check reachability and return basic service diagnostics."""

    @abstractmethod
    def login(self, credentials: Credentials) -> dict[str, Any]:
        """Authenticate and update the in-memory session."""

    @abstractmethod
    def load_session(self, path: str | None = None) -> dict[str, Any]:
        """Load a cached session."""

    @abstractmethod
    def save_session(self, path: str | None = None) -> dict[str, Any]:
        """Save current session."""

    @abstractmethod
    def current_user(self) -> dict[str, Any]:
        """Return current authenticated user/profile."""

    @abstractmethod
    def list_contests(self, page: int = 1, page_size: int = 50, search: str | None = None) -> Any:
        """List contests/games/competitions."""

    @abstractmethod
    def get_contest(self, contest_id: str | int) -> Any:
        """Return contest/game/competition detail."""

    @abstractmethod
    def join_contest(self, contest_id: str | int, team_id: str | int | None = None, invite_code: str | None = None) -> Any:
        """Register/join/enter a contest. team_id/invite_code are generic join hints."""

    @abstractmethod
    def list_challenges(
        self,
        contest_id: str | int | None = None,
        page: int = 1,
        page_size: int = 50,
        search: str | None = None,
    ) -> Any:
        """List challenges. contest_id=None means platform default/problem-bank if supported."""

    @abstractmethod
    def get_challenge(self, challenge_id: str | int, contest_id: str | int | None = None) -> Any:
        """Return challenge/problem detail."""

    @abstractmethod
    def download_attachment(self, challenge_id: str | int, outdir: str, contest_id: str | int | None = None) -> list[Any]:
        """Download challenge/problem attachments and return file descriptors."""

    @abstractmethod
    def submit_flag(self, challenge_id: str | int, flag: str, contest_id: str | int | None = None) -> Any:
        """Submit a flag and return the platform result."""

    @abstractmethod
    def scoreboard(self, contest_id: str | int | None = None) -> Any:
        """Return scoreboard/ranking where supported."""

    @abstractmethod
    def raw_client(self) -> Any:
        """Return underlying native client for rare escape hatches."""

    def unsupported(self, operation: str, detail: str | None = None) -> UnsupportedOperation:
        return UnsupportedOperation(self.platform, operation, detail)

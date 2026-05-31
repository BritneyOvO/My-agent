from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping


@dataclass(slots=True)
class PlatformConfig:
    """Runtime config shared by all platform adapters.

    Authentication exposed to upper layers has only two forms:
    username/password or token. Platform-specific header/cookie/session details
    are adapter/vendor responsibilities.
    """

    base_url: str | None = None
    timeout: int = 20
    verify: bool = True
    debug: bool = False
    session_file: str | None = None
    token: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        return self.extra.get(key, default)


@dataclass(slots=True)
class Credentials:
    """Authentication material.

    Use either username/password or token. `remember` and `captcha_token` are
    generic hints used only by platforms that need them.
    """

    username: str | None = None
    password: str | None = None
    token: str | None = None
    remember: bool = True
    captcha_token: str | None = None

    def is_token(self) -> bool:
        return bool(self.token)

    def require_password(self) -> tuple[str, str]:
        if not self.username or self.password is None:
            raise ValueError("username/password authentication requires both username and password")
        return self.username, self.password


@dataclass(slots=True)
class Attachment:
    url: str | None = None
    path: str | None = None
    name: str | None = None
    size: int | None = None
    content_type: str | None = None
    raw: Any = None


@dataclass(slots=True)
class SubmitResult:
    accepted: bool | None
    raw: Any
    message: str | None = None


def to_plain(obj: Any) -> Any:
    """Best-effort conversion to JSON-serializable Python primitives."""
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, Path):
        return str(obj)
    if hasattr(obj, "as_dict") and callable(obj.as_dict):
        return to_plain(obj.as_dict())
    if hasattr(obj, "__dataclass_fields__"):
        return {k: to_plain(getattr(obj, k)) for k in obj.__dataclass_fields__}
    if isinstance(obj, Mapping):
        return {str(k): to_plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [to_plain(x) for x in obj]
    if hasattr(obj, "__dict__"):
        return {k: to_plain(v) for k, v in vars(obj).items() if not k.startswith("_")}
    return repr(obj)

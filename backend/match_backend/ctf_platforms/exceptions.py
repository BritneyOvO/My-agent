from __future__ import annotations


class PlatformError(RuntimeError):
    """Base exception for this framework."""


class UnsupportedOperation(PlatformError):
    """Raised by an adapter when the platform cannot provide an interface method."""

    def __init__(self, platform: str, operation: str, detail: str | None = None):
        msg = f"{platform} does not support operation: {operation}"
        if detail:
            msg += f" ({detail})"
        super().__init__(msg)
        self.platform = platform
        self.operation = operation
        self.detail = detail


class PlatformNotFound(PlatformError):
    """Raised when asking the registry for an unknown platform."""

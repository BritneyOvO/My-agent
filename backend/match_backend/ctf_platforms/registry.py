from __future__ import annotations

from collections.abc import Iterable
from typing import Type

from .base import CTFPlatformClient
from .exceptions import PlatformNotFound
from .models import PlatformConfig


class PlatformRegistry:
    def __init__(self) -> None:
        self._classes: dict[str, type[CTFPlatformClient]] = {}
        self._aliases: dict[str, str] = {}

    def register(self, cls: type[CTFPlatformClient], *aliases: str) -> type[CTFPlatformClient]:
        key = cls.platform.lower()
        self._classes[key] = cls
        for alias in aliases:
            self._aliases[alias.lower()] = key
        return cls

    def keys(self) -> list[str]:
        return sorted(self._classes)

    def aliases(self) -> dict[str, str]:
        return dict(sorted(self._aliases.items()))

    def get_class(self, name: str) -> type[CTFPlatformClient]:
        key = name.lower()
        key = self._aliases.get(key, key)
        try:
            return self._classes[key]
        except KeyError as exc:
            known = ", ".join(self.keys())
            raise PlatformNotFound(f"Unknown platform {name!r}; known: {known}") from exc

    def create(self, name: str, config: PlatformConfig) -> CTFPlatformClient:
        return self.get_class(name)(config)


registry = PlatformRegistry()


def register_platform(*aliases: str):
    def deco(cls: type[CTFPlatformClient]) -> type[CTFPlatformClient]:
        registry.register(cls, *aliases)
        return cls
    return deco


def create_client(platform: str, config: PlatformConfig) -> CTFPlatformClient:
    ensure_builtin_adapters_loaded()
    return registry.create(platform, config)


def list_platforms() -> list[str]:
    ensure_builtin_adapters_loaded()
    return registry.keys()


def ensure_builtin_adapters_loaded() -> None:
    # Import side effects register all built-in adapters.
    from .adapters import adworld, ctfd, ctfplus, gzctf, nssctf  # noqa: F401

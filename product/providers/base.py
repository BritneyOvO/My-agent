"""
z3gh0ne Model Provider

Pluggable LLM abstraction. Supports multiple backends.
The product does NOT hardcode a specific model — the user injects their own API keys.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional
import os


@dataclass
class LLMResponse:
    text: str = ""
    model: str = ""
    usage: dict = field(default_factory=dict)
    raw: Optional[dict] = None


class BaseProvider(ABC):
    name: str = "base"

    @abstractmethod
    def complete(self, prompt: str, system: str = "", max_tokens: int = 4096) -> LLMResponse:
        ...

    @abstractmethod
    def available(self) -> bool:
        ...


class AnthropicProvider(BaseProvider):
    name = "anthropic"

    def __init__(self, api_key: str = None, model: str = "claude-sonnet-4-6"):
        self._api_key = api_key or os.getenv("Z3GH0NE_ANTHROPIC_KEY", "")
        self._model = model

    def available(self) -> bool:
        return bool(self._api_key)

    def complete(self, prompt: str, system: str = "", max_tokens: int = 4096) -> LLMResponse:
        if not self.available():
            return LLMResponse(text="[provider not configured]", model=self._model)
        try:
            from anthropic import Anthropic
            client = Anthropic(api_key=self._api_key)
            msg = client.messages.create(
                model=self._model,
                max_tokens=max_tokens,
                system=system or "You are z3gh0ne, a security analysis assistant.",
                messages=[{"role": "user", "content": prompt}],
            )
            text = "".join(b.text for b in msg.content if hasattr(b, "text"))
            return LLMResponse(
                text=text,
                model=self._model,
                usage={"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens},
            )
        except Exception as e:
            return LLMResponse(text=f"[error: {str(e)[:200]}]", model=self._model)


class OpenAICompatibleProvider(BaseProvider):
    name = "openai_compatible"

    def __init__(self, api_key: str = None, base_url: str = None, model: str = "gpt-4o"):
        self._api_key = api_key or os.getenv("Z3GH0NE_OPENAI_KEY", "")
        self._base_url = base_url or os.getenv("Z3GH0NE_OPENAI_BASE_URL", "https://api.openai.com/v1")
        self._model = model

    def available(self) -> bool:
        return bool(self._api_key)

    def complete(self, prompt: str, system: str = "", max_tokens: int = 4096) -> LLMResponse:
        if not self.available():
            return LLMResponse(text="[provider not configured]", model=self._model)
        try:
            import httpx
            resp = httpx.post(
                f"{self._base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={
                    "model": self._model,
                    "max_tokens": max_tokens,
                    "messages": [
                        {"role": "system", "content": system or "You are z3gh0ne, a security analysis assistant."},
                        {"role": "user", "content": prompt},
                    ],
                },
                timeout=120,
            )
            data = resp.json()
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            return LLMResponse(text=text, model=self._model, usage=data.get("usage", {}), raw=data)
        except Exception as e:
            return LLMResponse(text=f"[error: {str(e)[:200]}]", model=self._model)


class LocalAgentProvider(BaseProvider):
    """Represents the local Claude Code agent as the reasoning engine (no API call needed)."""
    name = "local_agent"

    def available(self) -> bool:
        return True

    def complete(self, prompt: str, system: str = "", max_tokens: int = 4096) -> LLMResponse:
        return LLMResponse(
            text="[local agent mode: reasoning handled by calling agent, not via API]",
            model="local-claude-code",
        )


class ProviderRegistry:
    def __init__(self):
        self._providers: dict[str, BaseProvider] = {}
        self._default: Optional[str] = None

    def register(self, provider: BaseProvider, default: bool = False):
        self._providers[provider.name] = provider
        if default or not self._default:
            self._default = provider.name

    def get(self, name: str = None) -> Optional[BaseProvider]:
        key = name or self._default
        return self._providers.get(key)

    def list_available(self) -> list[str]:
        return [name for name, p in self._providers.items() if p.available()]

    @classmethod
    def create_default(cls) -> ProviderRegistry:
        registry = cls()
        registry.register(LocalAgentProvider(), default=True)
        registry.register(AnthropicProvider())
        registry.register(OpenAICompatibleProvider())
        return registry

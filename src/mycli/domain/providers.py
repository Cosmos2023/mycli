from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class ProviderId(StrEnum):
    OPENAI = "openai"
    QWEN = "qwen"
    DEEPSEEK = "deepseek"
    ANTHROPIC = "anthropic"
    COMPATIBLE = "compatible"


class ProtocolId(StrEnum):
    RESPONSES = "responses"
    CHAT_COMPLETIONS = "chat_completions"
    ANTHROPIC_MESSAGES = "anthropic_messages"


@dataclass(slots=True, frozen=True)
class ProviderProfile:
    provider: ProviderId
    default_protocol: ProtocolId
    supports_responses: bool
    supports_chat_completions: bool
    default_base_url: str
    default_model: str | None = None
    unsupported_responses_hint: str | None = None
    supports_anthropic_messages: bool = False
    cache_policy_capability: Any | None = None


@dataclass(slots=True, frozen=True)
class ProviderQuirkProfile:
    provider_family: str
    protocol: ProtocolId
    cache_strategy: str
    prompt_cache_key_supported: bool
    cache_control_supported: bool
    automatic_prefix_cache: bool
    wire_hints_supported: bool
    reasoning_content_replay: str
    usage_cached_token_shape: str
    streaming_event_shape: str
    retry_error_shape: str

    def to_diagnostic_payload(self) -> dict[str, object]:
        return {
            "provider_family": self.provider_family,
            "protocol": self.protocol.value,
            "cache_strategy": self.cache_strategy,
            "prompt_cache_key_supported": self.prompt_cache_key_supported,
            "cache_control_supported": self.cache_control_supported,
            "automatic_prefix_cache": self.automatic_prefix_cache,
            "wire_hints_supported": self.wire_hints_supported,
            "reasoning_content_replay": self.reasoning_content_replay,
            "usage_cached_token_shape": self.usage_cached_token_shape,
            "streaming_event_shape": self.streaming_event_shape,
            "retry_error_shape": self.retry_error_shape,
        }


def parse_provider(value: object) -> ProviderId:
    try:
        return ProviderId(str(value))
    except ValueError as exc:
        allowed = ", ".join(item.value for item in ProviderId)
        raise ValueError(f"Unsupported provider '{value}'. Supported values: {allowed}.") from exc


def parse_protocol(value: object) -> ProtocolId:
    raw = str(value)
    if raw == "legacy_chat":
        raise ValueError(
            "Unsupported protocol 'legacy_chat'. Use 'chat_completions' instead."
        )
    try:
        return ProtocolId(raw)
    except ValueError as exc:
        allowed = ", ".join(item.value for item in ProtocolId)
        raise ValueError(f"Unsupported protocol '{value}'. Supported values: {allowed}.") from exc


__all__ = [
    "ProviderId",
    "ProviderProfile",
    "ProviderQuirkProfile",
    "ProtocolId",
    "parse_provider",
    "parse_protocol",
]

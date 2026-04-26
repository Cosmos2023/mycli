from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


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
    "ProtocolId",
    "parse_provider",
    "parse_protocol",
]

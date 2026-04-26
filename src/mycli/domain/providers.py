from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from urllib.parse import urlparse


class ProviderId(StrEnum):
    OPENAI = "openai"
    DEEPSEEK = "deepseek"
    COMPATIBLE = "compatible"


class ProtocolId(StrEnum):
    RESPONSES = "responses"
    CHAT_COMPLETIONS = "chat_completions"


@dataclass(slots=True, frozen=True)
class ProviderProfile:
    provider: ProviderId
    default_protocol: ProtocolId
    supports_responses: bool
    supports_chat_completions: bool
    default_base_url: str
    default_model: str | None = None
    unsupported_responses_hint: str | None = None


def infer_provider_from_base_url(base_url: str) -> ProviderId:
    hostname = urlparse(base_url).hostname or ""
    normalized = hostname.lower()
    if normalized == "api.deepseek.com" or normalized.endswith(".deepseek.com"):
        return ProviderId.DEEPSEEK
    if normalized == "api.openai.com" or normalized.endswith(".openai.com"):
        return ProviderId.OPENAI
    return ProviderId.COMPATIBLE


def profile_for_provider(provider: ProviderId) -> ProviderProfile:
    if provider is ProviderId.DEEPSEEK:
        return ProviderProfile(
            provider=ProviderId.DEEPSEEK,
            default_protocol=ProtocolId.CHAT_COMPLETIONS,
            supports_responses=False,
            supports_chat_completions=True,
            default_base_url="https://api.deepseek.com",
            default_model="deepseek-chat",
            unsupported_responses_hint="Use protocol='chat_completions' for DeepSeek.",
        )
    if provider is ProviderId.OPENAI:
        return ProviderProfile(
            provider=ProviderId.OPENAI,
            default_protocol=ProtocolId.RESPONSES,
            supports_responses=True,
            supports_chat_completions=True,
            default_base_url="https://api.openai.com/v1",
            default_model="gpt-5",
        )
    return ProviderProfile(
        provider=ProviderId.COMPATIBLE,
        default_protocol=ProtocolId.CHAT_COMPLETIONS,
        supports_responses=True,
        supports_chat_completions=True,
        default_base_url="https://api.openai.com/v1",
        default_model=None,
    )


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


def validate_provider_protocol(
    *,
    provider: ProviderId,
    protocol: ProtocolId,
) -> None:
    profile = profile_for_provider(provider)
    if protocol is ProtocolId.RESPONSES and not profile.supports_responses:
        hint = f" {profile.unsupported_responses_hint}" if profile.unsupported_responses_hint else ""
        raise ValueError(
            f"Provider '{provider.value}' does not support protocol '{protocol.value}'.{hint}"
        )
    if protocol is ProtocolId.CHAT_COMPLETIONS and not profile.supports_chat_completions:
        raise ValueError(
            f"Provider '{provider.value}' does not support protocol '{protocol.value}'."
        )


__all__ = [
    "ProviderId",
    "ProviderProfile",
    "ProtocolId",
    "infer_provider_from_base_url",
    "parse_provider",
    "parse_protocol",
    "profile_for_provider",
    "validate_provider_protocol",
]

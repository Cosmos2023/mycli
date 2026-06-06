from __future__ import annotations

from urllib.parse import urlparse

from mycli.domain.providers import ProtocolId, ProviderId, ProviderProfile
from mycli.domain.runtime.request_shape import ProviderCachePolicyCapability
from mycli.infrastructure.providers.anthropic import ANTHROPIC_PROFILE
from mycli.infrastructure.providers.deepseek import DEEPSEEK_PROFILE
from mycli.infrastructure.providers.openai import OPENAI_PROFILE
from mycli.infrastructure.providers.qwen import QWEN_PROFILE

COMPATIBLE_PROFILE = ProviderProfile(
    provider=ProviderId.COMPATIBLE,
    default_protocol=ProtocolId.CHAT_COMPLETIONS,
    supports_responses=True,
    supports_chat_completions=True,
    default_base_url="https://api.openai.com/v1",
    default_model=None,
    cache_policy_capability=ProviderCachePolicyCapability(
        prompt_cache_key_enabled=True,
        cache_control_enabled=False,
        provider_family="compatible",
        cache_strategy="prompt_cache_key",
    ),
)

_PROFILES: dict[ProviderId, ProviderProfile] = {
    ProviderId.OPENAI: OPENAI_PROFILE,
    ProviderId.QWEN: QWEN_PROFILE,
    ProviderId.DEEPSEEK: DEEPSEEK_PROFILE,
    ProviderId.ANTHROPIC: ANTHROPIC_PROFILE,
    ProviderId.COMPATIBLE: COMPATIBLE_PROFILE,
}


def infer_provider_from_base_url(base_url: str) -> ProviderId:
    hostname = urlparse(base_url).hostname or ""
    normalized = hostname.lower()
    if normalized == "api.deepseek.com" or normalized.endswith(".deepseek.com"):
        return ProviderId.DEEPSEEK
    if normalized == "api.anthropic.com" or normalized.endswith(".anthropic.com"):
        return ProviderId.ANTHROPIC
    if normalized == "dashscope.aliyuncs.com" or normalized.endswith(".dashscope.aliyuncs.com"):
        return ProviderId.QWEN
    if normalized == "api.openai.com" or normalized.endswith(".openai.com"):
        return ProviderId.OPENAI
    return ProviderId.COMPATIBLE


def profile_for_provider(provider: ProviderId) -> ProviderProfile:
    return _PROFILES[provider]


def resolve_provider_cache_policy_capability(
    *,
    provider: ProviderId,
    base_url: str | None = None,
    override: ProviderCachePolicyCapability | None = None,
) -> ProviderCachePolicyCapability:
    if override is not None:
        return override
    if provider is ProviderId.ANTHROPIC and base_url is not None:
        inferred_provider = infer_provider_from_base_url(base_url)
        if inferred_provider is not ProviderId.ANTHROPIC:
            provider = inferred_provider
    profile = profile_for_provider(provider)
    capability = profile.cache_policy_capability
    if isinstance(capability, ProviderCachePolicyCapability):
        return capability
    return ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=False,
    )


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
    if (
        protocol is ProtocolId.ANTHROPIC_MESSAGES
        and not profile.supports_anthropic_messages
    ):
        raise ValueError(
            f"Provider '{provider.value}' does not support protocol '{protocol.value}'."
        )


__all__ = [
    "COMPATIBLE_PROFILE",
    "infer_provider_from_base_url",
    "profile_for_provider",
    "resolve_provider_cache_policy_capability",
    "validate_provider_protocol",
]

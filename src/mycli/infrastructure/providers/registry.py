from __future__ import annotations

from urllib.parse import urlparse

from mycli.domain.providers import (
    ProtocolId,
    ProviderId,
    ProviderProfile,
    ProviderQuirkProfile,
)
from mycli.domain.runtime.request_shape import ProviderCachePolicyCapability
from mycli.infrastructure.providers.anthropic import ANTHROPIC_PROFILE
from mycli.infrastructure.providers.deepseek import DEEPSEEK_PROFILE
from mycli.infrastructure.providers.openai import CODEX_PROFILE
from mycli.infrastructure.providers.openai import OPENAI_PROFILE
from mycli.infrastructure.providers.qwen import QWEN_PROFILE

COMPATIBLE_PROFILE = ProviderProfile(
    provider=ProviderId.COMPATIBLE,
    default_protocol=ProtocolId.CHAT_COMPLETIONS,
    supports_responses=True,
    supports_chat_completions=True,
    default_base_url="https://api.openai.com/v1",
    default_model=None,
    supports_images=True,
    cache_policy_capability=ProviderCachePolicyCapability(
        prompt_cache_key_enabled=True,
        cache_control_enabled=False,
        provider_family="compatible",
        cache_strategy="prompt_cache_key",
    ),
)

_PROFILES: dict[ProviderId, ProviderProfile] = {
    ProviderId.OPENAI: OPENAI_PROFILE,
    ProviderId.CODEX: CODEX_PROFILE,
    ProviderId.QWEN: QWEN_PROFILE,
    ProviderId.DEEPSEEK: DEEPSEEK_PROFILE,
    ProviderId.ANTHROPIC: ANTHROPIC_PROFILE,
    ProviderId.COMPATIBLE: COMPATIBLE_PROFILE,
}

_DEFAULT_RETRY_ERROR_SHAPE = "openai_compatible_error"

_QUIRK_PROFILES: dict[tuple[ProviderId, ProtocolId], ProviderQuirkProfile] = {
    (ProviderId.OPENAI, ProtocolId.RESPONSES): ProviderQuirkProfile(
        provider_family="openai",
        protocol=ProtocolId.RESPONSES,
        cache_strategy="prompt_cache_key",
        prompt_cache_key_supported=True,
        cache_control_supported=False,
        automatic_prefix_cache=False,
        wire_hints_supported=True,
        reasoning_content_replay="encrypted_reasoning_supported",
        usage_cached_token_shape="input_tokens_details.cached_tokens",
        streaming_event_shape="responses_events",
        retry_error_shape="responses_error",
    ),
    (ProviderId.CODEX, ProtocolId.RESPONSES): ProviderQuirkProfile(
        provider_family="codex",
        protocol=ProtocolId.RESPONSES,
        cache_strategy="prompt_cache_key",
        prompt_cache_key_supported=True,
        cache_control_supported=False,
        automatic_prefix_cache=False,
        wire_hints_supported=True,
        reasoning_content_replay="encrypted_reasoning_supported",
        usage_cached_token_shape="input_tokens_details.cached_tokens",
        streaming_event_shape="responses_events",
        retry_error_shape="responses_error",
    ),
    (ProviderId.OPENAI, ProtocolId.CHAT_COMPLETIONS): ProviderQuirkProfile(
        provider_family="openai",
        protocol=ProtocolId.CHAT_COMPLETIONS,
        cache_strategy="prompt_cache_key",
        prompt_cache_key_supported=True,
        cache_control_supported=False,
        automatic_prefix_cache=False,
        wire_hints_supported=True,
        reasoning_content_replay="none",
        usage_cached_token_shape="prompt_tokens_details.cached_tokens",
        streaming_event_shape="chat_completion_chunks",
        retry_error_shape=_DEFAULT_RETRY_ERROR_SHAPE,
    ),
    (ProviderId.COMPATIBLE, ProtocolId.RESPONSES): ProviderQuirkProfile(
        provider_family="compatible",
        protocol=ProtocolId.RESPONSES,
        cache_strategy="prompt_cache_key",
        prompt_cache_key_supported=True,
        cache_control_supported=False,
        automatic_prefix_cache=False,
        wire_hints_supported=True,
        reasoning_content_replay="provider_defined",
        usage_cached_token_shape="openai_compatible_cached_tokens",
        streaming_event_shape="responses_compatible_events",
        retry_error_shape="compatible_error",
    ),
    (ProviderId.COMPATIBLE, ProtocolId.CHAT_COMPLETIONS): ProviderQuirkProfile(
        provider_family="compatible",
        protocol=ProtocolId.CHAT_COMPLETIONS,
        cache_strategy="prompt_cache_key",
        prompt_cache_key_supported=True,
        cache_control_supported=False,
        automatic_prefix_cache=False,
        wire_hints_supported=True,
        reasoning_content_replay="provider_defined",
        usage_cached_token_shape="openai_compatible_cached_tokens",
        streaming_event_shape="chat_completion_chunks",
        retry_error_shape="compatible_error",
    ),
    (ProviderId.QWEN, ProtocolId.RESPONSES): ProviderQuirkProfile(
        provider_family="qwen",
        protocol=ProtocolId.RESPONSES,
        cache_strategy="cache_control",
        prompt_cache_key_supported=False,
        cache_control_supported=True,
        automatic_prefix_cache=False,
        wire_hints_supported=True,
        reasoning_content_replay="provider_defined",
        usage_cached_token_shape="prompt_tokens_details.cached_tokens",
        streaming_event_shape="responses_compatible_events",
        retry_error_shape="compatible_error",
    ),
    (ProviderId.QWEN, ProtocolId.CHAT_COMPLETIONS): ProviderQuirkProfile(
        provider_family="qwen",
        protocol=ProtocolId.CHAT_COMPLETIONS,
        cache_strategy="cache_control",
        prompt_cache_key_supported=False,
        cache_control_supported=True,
        automatic_prefix_cache=False,
        wire_hints_supported=True,
        reasoning_content_replay="provider_defined",
        usage_cached_token_shape="prompt_tokens_details.cached_tokens",
        streaming_event_shape="chat_completion_chunks",
        retry_error_shape="compatible_error",
    ),
    (ProviderId.ANTHROPIC, ProtocolId.ANTHROPIC_MESSAGES): ProviderQuirkProfile(
        provider_family="anthropic",
        protocol=ProtocolId.ANTHROPIC_MESSAGES,
        cache_strategy="cache_control",
        prompt_cache_key_supported=False,
        cache_control_supported=True,
        automatic_prefix_cache=False,
        wire_hints_supported=True,
        reasoning_content_replay="none",
        usage_cached_token_shape="cache_read_input_tokens",
        streaming_event_shape="anthropic_messages_events",
        retry_error_shape="anthropic_error",
    ),
    (ProviderId.DEEPSEEK, ProtocolId.CHAT_COMPLETIONS): ProviderQuirkProfile(
        provider_family="deepseek",
        protocol=ProtocolId.CHAT_COMPLETIONS,
        cache_strategy="automatic_prefix_cache",
        prompt_cache_key_supported=False,
        cache_control_supported=False,
        automatic_prefix_cache=True,
        wire_hints_supported=False,
        reasoning_content_replay="reasoning_content_required_for_tool_replay",
        usage_cached_token_shape="prompt_cache_hit_tokens",
        streaming_event_shape="chat_completion_chunks",
        retry_error_shape="deepseek_error",
    ),
    (ProviderId.DEEPSEEK, ProtocolId.ANTHROPIC_MESSAGES): ProviderQuirkProfile(
        provider_family="deepseek",
        protocol=ProtocolId.ANTHROPIC_MESSAGES,
        cache_strategy="automatic_prefix_cache",
        prompt_cache_key_supported=False,
        cache_control_supported=False,
        automatic_prefix_cache=True,
        wire_hints_supported=False,
        reasoning_content_replay="anthropic_style_reasoning_opaque",
        usage_cached_token_shape="anthropic_style_cache_read_input_tokens",
        streaming_event_shape="anthropic_messages_compatible_events",
        retry_error_shape="deepseek_anthropic_error",
    ),
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


def resolve_provider_quirk_profile(
    *,
    provider: ProviderId,
    protocol: ProtocolId,
    base_url: str | None = None,
) -> ProviderQuirkProfile:
    effective_provider = provider
    if base_url is not None:
        inferred_provider = infer_provider_from_base_url(base_url)
        if provider is ProviderId.ANTHROPIC and inferred_provider is ProviderId.DEEPSEEK:
            effective_provider = ProviderId.DEEPSEEK
        elif provider is ProviderId.COMPATIBLE and inferred_provider is not ProviderId.COMPATIBLE:
            effective_provider = inferred_provider
    profile = _QUIRK_PROFILES.get((effective_provider, protocol))
    if profile is not None:
        return profile
    if protocol is ProtocolId.ANTHROPIC_MESSAGES:
        return ProviderQuirkProfile(
            provider_family=effective_provider.value,
            protocol=protocol,
            cache_strategy="unsupported",
            prompt_cache_key_supported=False,
            cache_control_supported=False,
            automatic_prefix_cache=False,
            wire_hints_supported=False,
            reasoning_content_replay="unknown",
            usage_cached_token_shape="unknown",
            streaming_event_shape="unknown",
            retry_error_shape="unknown",
        )
    return _QUIRK_PROFILES[(ProviderId.COMPATIBLE, protocol)]


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
    "resolve_provider_quirk_profile",
    "validate_provider_protocol",
]

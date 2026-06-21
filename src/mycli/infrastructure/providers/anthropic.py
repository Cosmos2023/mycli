from __future__ import annotations

from mycli.domain.providers import ProtocolId, ProviderId, ProviderProfile
from mycli.domain.runtime.request_shape import ProviderCachePolicyCapability

ANTHROPIC_PROFILE = ProviderProfile(
    provider=ProviderId.ANTHROPIC,
    default_protocol=ProtocolId.ANTHROPIC_MESSAGES,
    supports_responses=False,
    supports_chat_completions=False,
    supports_anthropic_messages=True,
    default_base_url="https://api.anthropic.com",
    default_model="claude-sonnet-4-6",
    supports_images=True,
    unsupported_responses_hint="Use protocol='anthropic_messages' for Anthropic.",
    cache_policy_capability=ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=True,
        provider_family="anthropic",
        cache_strategy="cache_control",
    ),
)

ANTHROPIC_HIGH_CAPABILITY_MODEL = "claude-opus-4-7"

__all__ = [
    "ANTHROPIC_HIGH_CAPABILITY_MODEL",
    "ANTHROPIC_PROFILE",
]

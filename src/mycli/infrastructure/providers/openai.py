from __future__ import annotations

from mycli.domain.providers import ProtocolId, ProviderId, ProviderProfile
from mycli.domain.runtime.request_shape import ProviderCachePolicyCapability
from mycli.infrastructure.providers.chat import DefaultChatProviderAdapter

OPENAI_PROFILE = ProviderProfile(
    provider=ProviderId.OPENAI,
    default_protocol=ProtocolId.RESPONSES,
    supports_responses=True,
    supports_chat_completions=True,
    default_base_url="https://api.openai.com/v1",
    default_model="gpt-5",
    cache_policy_capability=ProviderCachePolicyCapability(
        prompt_cache_key_enabled=True,
        cache_control_enabled=False,
    ),
)


class OpenAIChatProviderAdapter(DefaultChatProviderAdapter):
    provider = ProviderId.OPENAI


__all__ = ["OPENAI_PROFILE", "OpenAIChatProviderAdapter"]

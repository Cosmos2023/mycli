from __future__ import annotations

from mycli.domain.providers import ProtocolId, ProviderId, ProviderProfile
from mycli.domain.runtime.request_shape import ProviderCachePolicyCapability
from mycli.infrastructure.providers.chat import DefaultChatProviderAdapter

QWEN_PROFILE = ProviderProfile(
    provider=ProviderId.QWEN,
    default_protocol=ProtocolId.RESPONSES,
    supports_responses=True,
    supports_chat_completions=True,
    default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model="qwen3.6-plus",
    cache_policy_capability=ProviderCachePolicyCapability(
        prompt_cache_key_enabled=True,
        cache_control_enabled=False,
        provider_family="qwen",
        cache_strategy="prompt_cache_key",
    ),
)


class QwenChatProviderAdapter(DefaultChatProviderAdapter):
    provider = ProviderId.QWEN


__all__ = ["QWEN_PROFILE", "QwenChatProviderAdapter"]

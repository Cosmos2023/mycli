from __future__ import annotations

from mycli.domain.providers import ProtocolId, ProviderId, ProviderProfile
from mycli.infrastructure.providers.chat import DefaultChatProviderAdapter

QWEN_PROFILE = ProviderProfile(
    provider=ProviderId.QWEN,
    default_protocol=ProtocolId.RESPONSES,
    supports_responses=True,
    supports_chat_completions=True,
    default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model="qwen3.6-plus",
)


class QwenChatProviderAdapter(DefaultChatProviderAdapter):
    provider = ProviderId.QWEN


__all__ = ["QWEN_PROFILE", "QwenChatProviderAdapter"]

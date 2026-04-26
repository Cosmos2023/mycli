from __future__ import annotations

from mycli.domain.providers import ProviderId
from mycli.infrastructure.providers.chat import (
    ChatProviderAdapter,
    ChatProviderSettings,
    DefaultChatProviderAdapter,
)
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter
from mycli.infrastructure.providers.openai import OpenAIChatProviderAdapter
from mycli.infrastructure.providers.qwen import QwenChatProviderAdapter
from mycli.infrastructure.providers.registry import (
    infer_provider_from_base_url,
    profile_for_provider,
    validate_provider_protocol,
)


def chat_adapter_for_provider(provider: ProviderId) -> ChatProviderAdapter:
    if provider is ProviderId.OPENAI:
        return OpenAIChatProviderAdapter()
    if provider is ProviderId.QWEN:
        return QwenChatProviderAdapter()
    if provider is ProviderId.DEEPSEEK:
        return DeepSeekChatProviderAdapter()
    return DefaultChatProviderAdapter()


__all__ = [
    "ChatProviderAdapter",
    "ChatProviderSettings",
    "DeepSeekChatProviderAdapter",
    "DefaultChatProviderAdapter",
    "OpenAIChatProviderAdapter",
    "QwenChatProviderAdapter",
    "chat_adapter_for_provider",
    "infer_provider_from_base_url",
    "profile_for_provider",
    "validate_provider_protocol",
]

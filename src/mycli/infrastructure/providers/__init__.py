from __future__ import annotations

from mycli.domain.providers import ProviderId
from mycli.infrastructure.providers.chat import (
    ChatProviderAdapter,
    ChatProviderSettings,
    DefaultChatProviderAdapter,
)
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter


def chat_adapter_for_provider(provider: ProviderId) -> ChatProviderAdapter:
    if provider is ProviderId.DEEPSEEK:
        return DeepSeekChatProviderAdapter()
    return DefaultChatProviderAdapter()


__all__ = [
    "ChatProviderAdapter",
    "ChatProviderSettings",
    "DeepSeekChatProviderAdapter",
    "DefaultChatProviderAdapter",
    "chat_adapter_for_provider",
]

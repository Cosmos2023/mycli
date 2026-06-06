from __future__ import annotations

from mycli.domain.providers import ProviderId
from mycli.infrastructure.providers.chat import (
    ChatProviderAdapter,
    ChatProviderSettings,
    DefaultChatProviderAdapter,
)
from mycli.infrastructure.providers.anthropic import ANTHROPIC_PROFILE
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter
from mycli.infrastructure.providers.deepseek import DEEPSEEK_PROFILE
from mycli.infrastructure.providers.openai import OpenAIChatProviderAdapter
from mycli.infrastructure.providers.openai import OPENAI_PROFILE
from mycli.infrastructure.providers.qwen import QwenChatProviderAdapter
from mycli.infrastructure.providers.qwen import QWEN_PROFILE
from mycli.infrastructure.providers.registry import (
    infer_provider_from_base_url,
    profile_for_provider,
    resolve_provider_cache_policy_capability,
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
    "ANTHROPIC_PROFILE",
    "ChatProviderAdapter",
    "ChatProviderSettings",
    "DEEPSEEK_PROFILE",
    "DeepSeekChatProviderAdapter",
    "DefaultChatProviderAdapter",
    "OPENAI_PROFILE",
    "OpenAIChatProviderAdapter",
    "QWEN_PROFILE",
    "QwenChatProviderAdapter",
    "chat_adapter_for_provider",
    "infer_provider_from_base_url",
    "profile_for_provider",
    "resolve_provider_cache_policy_capability",
    "validate_provider_protocol",
]

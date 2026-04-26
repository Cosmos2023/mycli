from mycli.domain.providers import ProviderId
from mycli.domain.providers import ProtocolId
from mycli.infrastructure.providers import chat_adapter_for_provider, profile_for_provider
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter
from mycli.infrastructure.providers.deepseek import DEEPSEEK_PROFILE
from mycli.infrastructure.providers.openai import OpenAIChatProviderAdapter
from mycli.infrastructure.providers.openai import OPENAI_PROFILE
from mycli.infrastructure.providers.qwen import QwenChatProviderAdapter
from mycli.infrastructure.providers.qwen import QWEN_PROFILE


def test_chat_adapter_for_provider_routes_named_providers() -> None:
    assert isinstance(
        chat_adapter_for_provider(ProviderId.OPENAI),
        OpenAIChatProviderAdapter,
    )
    assert isinstance(
        chat_adapter_for_provider(ProviderId.QWEN),
        QwenChatProviderAdapter,
    )
    assert isinstance(
        chat_adapter_for_provider(ProviderId.DEEPSEEK),
        DeepSeekChatProviderAdapter,
    )


def test_profile_for_provider_uses_provider_module_profiles() -> None:
    assert profile_for_provider(ProviderId.OPENAI) is OPENAI_PROFILE
    assert profile_for_provider(ProviderId.QWEN) is QWEN_PROFILE
    assert profile_for_provider(ProviderId.DEEPSEEK) is DEEPSEEK_PROFILE

    assert OPENAI_PROFILE.default_protocol is ProtocolId.RESPONSES
    assert QWEN_PROFILE.default_base_url == (
        "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
    assert DEEPSEEK_PROFILE.default_protocol is ProtocolId.CHAT_COMPLETIONS

from mycli.domain.providers import ProviderId
from mycli.domain.providers import ProtocolId
from mycli.domain.runtime import ProviderCachePolicyCapability
from mycli.infrastructure.providers import (
    chat_adapter_for_provider,
    infer_provider_from_base_url,
    profile_for_provider,
    resolve_provider_quirk_profile,
)
from mycli.infrastructure.providers import resolve_provider_cache_policy_capability
from mycli.infrastructure.providers.anthropic import ANTHROPIC_PROFILE
from mycli.infrastructure.providers.deepseek import (
    DEEPSEEK_SYNTHETIC_REASONING_CONTENT,
    DeepSeekChatProviderAdapter,
)
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
    assert profile_for_provider(ProviderId.ANTHROPIC) is ANTHROPIC_PROFILE

    assert OPENAI_PROFILE.default_protocol is ProtocolId.RESPONSES
    assert QWEN_PROFILE.default_base_url == (
        "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
    assert DEEPSEEK_PROFILE.default_protocol is ProtocolId.CHAT_COMPLETIONS
    assert ANTHROPIC_PROFILE.default_protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert ANTHROPIC_PROFILE.default_base_url == "https://api.anthropic.com"


def test_provider_profiles_declare_safe_cache_policy_capabilities() -> None:
    assert OPENAI_PROFILE.cache_policy_capability == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=True,
        cache_control_enabled=False,
        provider_family="openai",
        cache_strategy="prompt_cache_key",
    )
    assert QWEN_PROFILE.cache_policy_capability == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=True,
        cache_control_enabled=False,
        provider_family="qwen",
        cache_strategy="prompt_cache_key",
    )
    assert DEEPSEEK_PROFILE.cache_policy_capability == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=False,
        wire_hints_supported=False,
        provider_family="deepseek",
        cache_strategy="automatic_prefix_cache",
    )
    assert ANTHROPIC_PROFILE.cache_policy_capability == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=True,
        provider_family="anthropic",
        cache_strategy="cache_control",
    )


def test_resolve_provider_cache_policy_capability_prefers_config_override() -> None:
    override = ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=False,
    )

    resolved = resolve_provider_cache_policy_capability(
        provider=ProviderId.OPENAI,
        override=override,
    )

    assert resolved is override


def test_deepseek_profile_resolves_unsupported_wire_hint_capability() -> None:
    resolved = resolve_provider_cache_policy_capability(provider=ProviderId.DEEPSEEK)

    assert resolved == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=False,
        wire_hints_supported=False,
        provider_family="deepseek",
        cache_strategy="automatic_prefix_cache",
    )


def test_anthropic_deepseek_base_url_disables_ignored_cache_control_by_default() -> None:
    resolved = resolve_provider_cache_policy_capability(
        provider=ProviderId.ANTHROPIC,
        base_url="https://api.deepseek.com/anthropic",
    )

    assert resolved == ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=False,
        wire_hints_supported=False,
        provider_family="deepseek",
        cache_strategy="automatic_prefix_cache",
    )


def test_anthropic_deepseek_base_url_cache_policy_can_be_overridden() -> None:
    override = ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=True,
    )

    resolved = resolve_provider_cache_policy_capability(
        provider=ProviderId.ANTHROPIC,
        base_url="https://api.deepseek.com/anthropic",
        override=override,
    )

    assert resolved is override


def test_provider_quirk_profile_resolves_openai_responses() -> None:
    profile = resolve_provider_quirk_profile(
        provider=ProviderId.OPENAI,
        protocol=ProtocolId.RESPONSES,
        base_url="https://api.openai.com/v1",
    )

    assert profile.provider_family == "openai"
    assert profile.protocol is ProtocolId.RESPONSES
    assert profile.prompt_cache_key_supported is True
    assert profile.cache_control_supported is False
    assert profile.usage_cached_token_shape == "input_tokens_details.cached_tokens"


def test_provider_quirk_profile_resolves_compatible_chat() -> None:
    profile = resolve_provider_quirk_profile(
        provider=ProviderId.COMPATIBLE,
        protocol=ProtocolId.CHAT_COMPLETIONS,
        base_url="https://example.invalid/v1",
    )

    assert profile.provider_family == "compatible"
    assert profile.protocol is ProtocolId.CHAT_COMPLETIONS
    assert profile.prompt_cache_key_supported is True
    assert profile.cache_control_supported is False
    assert profile.wire_hints_supported is True


def test_provider_quirk_profile_resolves_anthropic_messages() -> None:
    profile = resolve_provider_quirk_profile(
        provider=ProviderId.ANTHROPIC,
        protocol=ProtocolId.ANTHROPIC_MESSAGES,
        base_url="https://api.anthropic.com",
    )

    assert profile.provider_family == "anthropic"
    assert profile.cache_strategy == "cache_control"
    assert profile.prompt_cache_key_supported is False
    assert profile.cache_control_supported is True
    assert profile.usage_cached_token_shape == "cache_read_input_tokens"


def test_provider_quirk_profile_resolves_deepseek_chat() -> None:
    profile = resolve_provider_quirk_profile(
        provider=ProviderId.DEEPSEEK,
        protocol=ProtocolId.CHAT_COMPLETIONS,
        base_url="https://api.deepseek.com",
    )

    assert profile.provider_family == "deepseek"
    assert profile.cache_strategy == "automatic_prefix_cache"
    assert profile.automatic_prefix_cache is True
    assert profile.wire_hints_supported is False
    assert profile.reasoning_content_replay == "reasoning_content_required_for_tool_replay"


def test_provider_quirk_profile_resolves_deepseek_anthropic_style_endpoint() -> None:
    profile = resolve_provider_quirk_profile(
        provider=ProviderId.ANTHROPIC,
        protocol=ProtocolId.ANTHROPIC_MESSAGES,
        base_url="https://api.deepseek.com/anthropic",
    )

    assert profile.provider_family == "deepseek"
    assert profile.protocol is ProtocolId.ANTHROPIC_MESSAGES
    assert profile.cache_strategy == "automatic_prefix_cache"
    assert profile.cache_control_supported is False
    assert profile.streaming_event_shape == "anthropic_messages_compatible_events"


def test_infer_provider_from_base_url_detects_anthropic_hosts() -> None:
    assert infer_provider_from_base_url("https://api.anthropic.com") is ProviderId.ANTHROPIC
    assert infer_provider_from_base_url("https://console.anthropic.com") is ProviderId.ANTHROPIC


def test_deepseek_adapter_merges_developer_rules_into_cacheable_system_prefix() -> None:
    messages = DeepSeekChatProviderAdapter().adapt_messages(
        [
            {"role": "system", "content": "Base instructions."},
            {"role": "developer", "content": "Stable runtime rules."},
            {"role": "user", "content": "Current request."},
        ]
    )

    assert messages == [
        {
            "role": "system",
            "content": "Base instructions.\n\nStable runtime rules.",
        },
        {"role": "user", "content": "Current request."},
    ]


def test_deepseek_adapter_adds_stable_reasoning_fallback_for_tool_call_replay() -> None:
    messages = DeepSeekChatProviderAdapter().adapt_messages(
        [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_read_1",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": "{\"path\":\"README.md\"}"},
                    }
                ],
            },
        ]
    )

    assert messages[0]["reasoning_content"] == DEEPSEEK_SYNTHETIC_REASONING_CONTENT


def test_deepseek_adapter_marks_missing_provider_reasoning_metadata_for_tool_calls() -> None:
    metadata = DeepSeekChatProviderAdapter().extract_message_metadata(
        {
            "content": "",
            "tool_calls": [
                {
                    "id": "call_read_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{\"path\":\"README.md\"}"},
                }
            ],
        }
    )

    assert metadata == {
        "deepseek": {
            "reasoning_content": DEEPSEEK_SYNTHETIC_REASONING_CONTENT,
            "reasoning_content_missing": True,
        }
    }


def test_openai_chat_provider_adapter_strips_provider_private_fields() -> None:
    adapter = OpenAIChatProviderAdapter()

    adapted = adapter.adapt_messages(
        [
            {
                "role": "user",
                "content": "hello",
                "metadata": {"provider_request_policy": {"prompt_cache_key": "key"}},
                "cache_control": {"type": "ephemeral"},
                "anthropic": {"type": "thinking"},
                "responses": {"encrypted_reasoning": "..."},
                "_provider_state": {"opaque": True},
            }
        ]
    )

    assert adapted == [{"role": "user", "content": "hello"}]


def test_openai_chat_provider_adapter_strips_nested_provider_private_fields() -> None:
    adapter = OpenAIChatProviderAdapter()

    adapted = adapter.adapt_messages(
        [
            {
                "role": "assistant",
                "content": "done",
                "provider_state": {"codex_reasoning_items": ["opaque"]},
                "responses": {
                    "codex_message_items": [{"id": "msg_1"}],
                    "reasoning": {"encrypted_content": "opaque"},
                },
                "anthropic": {
                    "type": "thinking",
                    "thinking": "private",
                    "signature": "sig",
                },
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "Read",
                            "arguments": "{}",
                            "_provider_debug": "drop",
                        },
                        "_internal": "drop",
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
            }
        ]
    )

    assert adapted == [
        {
            "role": "assistant",
            "content": "done",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "Read",
                        "arguments": "{}",
                    },
                }
            ],
        }
    ]

from __future__ import annotations

from typing import cast

from mycli.domain.providers import ProtocolId, ProviderId, ProviderProfile
from mycli.domain.runtime.request_shape import ProviderCachePolicyCapability
from mycli.infrastructure.providers.chat import DefaultChatProviderAdapter
from mycli.utils.provider_replay import sanitize_provider_private

QWEN_PROFILE = ProviderProfile(
    provider=ProviderId.QWEN,
    default_protocol=ProtocolId.CHAT_COMPLETIONS,
    supports_responses=True,
    supports_chat_completions=True,
    default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    default_model="qwen3.6-plus",
    cache_policy_capability=ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=True,
        provider_family="qwen",
        cache_strategy="cache_control",
    ),
)


class QwenChatProviderAdapter(DefaultChatProviderAdapter):
    provider = ProviderId.QWEN

    def adapt_messages(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        adapted_messages: list[dict[str, object]] = []
        for message in messages:
            metadata = message.get("metadata")
            adapted_message = cast(
                dict[str, object],
                sanitize_provider_private(message),
            )
            if self._should_emit_cache_control(metadata):
                content = adapted_message.get("content")
                if isinstance(content, str) and content:
                    adapted_message["content"] = [
                        {
                            "type": "text",
                            "text": content,
                            "cache_control": {"type": "ephemeral"},
                        }
                    ]
            for key in tuple(adapted_message):
                if self._provider_private_message_key(key):
                    adapted_message.pop(key, None)
            adapted_messages.append(adapted_message)
        return adapted_messages

    def _should_emit_cache_control(self, metadata: object) -> bool:
        if not isinstance(metadata, dict):
            return False
        breakpoint = metadata.get("qwen_cache_control_breakpoint")
        if not isinstance(breakpoint, str) or not breakpoint:
            return False
        policy = metadata.get("provider_request_policy")
        if not isinstance(policy, dict):
            return True
        breakpoints = policy.get("cache_control_breakpoints")
        return isinstance(breakpoints, (list, tuple)) and breakpoint in breakpoints


__all__ = ["QWEN_PROFILE", "QwenChatProviderAdapter"]

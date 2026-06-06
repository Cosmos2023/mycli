from __future__ import annotations

from mycli.domain.providers import ProtocolId, ProviderId, ProviderProfile
from mycli.domain.runtime.request_shape import ProviderCachePolicyCapability
from mycli.infrastructure.providers.chat import ChatProviderSettings

DEEPSEEK_METADATA_KEY = "deepseek"
DEEPSEEK_SYNTHETIC_REASONING_CONTENT = (
    "Provider omitted reasoning_content for this tool call."
)
DEEPSEEK_PROFILE = ProviderProfile(
    provider=ProviderId.DEEPSEEK,
    default_protocol=ProtocolId.CHAT_COMPLETIONS,
    supports_responses=False,
    supports_chat_completions=True,
    default_base_url="https://api.deepseek.com",
    default_model="deepseek-chat",
    unsupported_responses_hint="Use protocol='chat_completions' for DeepSeek.",
    cache_policy_capability=ProviderCachePolicyCapability(
        prompt_cache_key_enabled=False,
        cache_control_enabled=False,
        wire_hints_supported=False,
    ),
)


class DeepSeekChatProviderAdapter:
    provider = ProviderId.DEEPSEEK

    def adapt_messages(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        adapted_messages: list[dict[str, object]] = []
        for message in messages:
            adapted_message = dict(message)
            metadata = adapted_message.pop("metadata", None)
            if adapted_message.get("role") == "developer":
                adapted_message["role"] = "system"
            reasoning_content = self._reasoning_content_from_metadata(metadata)
            if reasoning_content is None and self._requires_reasoning_replay(
                adapted_message
            ):
                reasoning_content = DEEPSEEK_SYNTHETIC_REASONING_CONTENT
            if (
                adapted_message.get("role") == "assistant"
                and reasoning_content is not None
            ):
                adapted_message["reasoning_content"] = reasoning_content
            self._append_message(adapted_messages, adapted_message)
        return adapted_messages

    def adapt_request_body(
        self,
        payload_body: dict[str, object],
        *,
        settings: ChatProviderSettings,
    ) -> dict[str, object]:
        adapted_payload = dict(payload_body)
        if not settings.thinking_enabled:
            adapted_payload["extra_body"] = {"thinking": {"type": "disabled"}}
            adapted_payload.pop("reasoning_effort", None)
            return adapted_payload
        adapted_payload["extra_body"] = {"thinking": {"type": "enabled"}}
        adapted_payload["reasoning_effort"] = self._reasoning_effort(
            settings.thinking_effort
        )
        return adapted_payload

    def _reasoning_effort(self, effort: str | None) -> str:
        if effort == "max":
            return "max"
        if effort == "xhigh":
            return "max"
        return "high"

    def extract_message_metadata(
        self,
        message: dict[str, object],
    ) -> dict[str, object]:
        reasoning_content = message.get("reasoning_content")
        if isinstance(reasoning_content, str) and reasoning_content.strip():
            return {
                DEEPSEEK_METADATA_KEY: {
                    "reasoning_content": reasoning_content,
                }
            }
        if self._has_tool_calls(message):
            return {
                DEEPSEEK_METADATA_KEY: {
                    "reasoning_content": DEEPSEEK_SYNTHETIC_REASONING_CONTENT,
                    "reasoning_content_missing": True,
                }
            }
        return {}

    def _reasoning_content_from_metadata(self, metadata: object) -> str | None:
        if not isinstance(metadata, dict):
            return None
        deepseek_metadata = metadata.get(DEEPSEEK_METADATA_KEY)
        if not isinstance(deepseek_metadata, dict):
            return None
        reasoning_content = deepseek_metadata.get("reasoning_content")
        if isinstance(reasoning_content, str) and reasoning_content.strip():
            return reasoning_content
        return None

    def _requires_reasoning_replay(self, message: dict[str, object]) -> bool:
        return message.get("role") == "assistant" and self._has_tool_calls(message)

    def _has_tool_calls(self, message: dict[str, object]) -> bool:
        tool_calls = message.get("tool_calls")
        return isinstance(tool_calls, list) and bool(tool_calls)

    def _append_message(
        self,
        messages: list[dict[str, object]],
        message: dict[str, object],
    ) -> None:
        if not self._can_merge_system_message(message):
            messages.append(message)
            return
        if not messages or not self._can_merge_system_message(messages[-1]):
            messages.append(message)
            return
        previous_content = str(messages[-1]["content"])
        current_content = str(message["content"])
        messages[-1] = {
            "role": "system",
            "content": f"{previous_content}\n\n{current_content}",
        }

    def _can_merge_system_message(self, message: dict[str, object]) -> bool:
        return (
            set(message) == {"role", "content"}
            and message.get("role") == "system"
            and isinstance(message.get("content"), str)
            and bool(str(message["content"]).strip())
        )


__all__ = [
    "DEEPSEEK_METADATA_KEY",
    "DEEPSEEK_PROFILE",
    "DEEPSEEK_SYNTHETIC_REASONING_CONTENT",
    "DeepSeekChatProviderAdapter",
]

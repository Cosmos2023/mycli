from __future__ import annotations

from mycli.domain.providers import ProtocolId, ProviderId, ProviderProfile
from mycli.infrastructure.providers.chat import ChatProviderSettings

DEEPSEEK_METADATA_KEY = "deepseek"
DEEPSEEK_PROFILE = ProviderProfile(
    provider=ProviderId.DEEPSEEK,
    default_protocol=ProtocolId.CHAT_COMPLETIONS,
    supports_responses=False,
    supports_chat_completions=True,
    default_base_url="https://api.deepseek.com",
    default_model="deepseek-chat",
    unsupported_responses_hint="Use protocol='chat_completions' for DeepSeek.",
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
        return adapted_payload

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
    "DeepSeekChatProviderAdapter",
]

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
            adapted_messages.append(adapted_message)
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


__all__ = [
    "DEEPSEEK_METADATA_KEY",
    "DEEPSEEK_PROFILE",
    "DeepSeekChatProviderAdapter",
]

from __future__ import annotations

from mycli.domain.providers import ProviderId
from mycli.infrastructure.providers.chat import ChatProviderSettings

DEEPSEEK_METADATA_KEY = "deepseek"


class DeepSeekChatProviderAdapter:
    provider = ProviderId.DEEPSEEK

    def adapt_messages(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        adapted_messages: list[dict[str, object]] = []
        for message in messages:
            adapted_message = dict(message)
            if adapted_message.get("role") == "developer":
                adapted_message["role"] = "system"
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


__all__ = [
    "DEEPSEEK_METADATA_KEY",
    "DeepSeekChatProviderAdapter",
]

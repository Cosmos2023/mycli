from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from mycli.domain.providers import ProviderId


@dataclass(slots=True, frozen=True)
class ChatProviderSettings:
    thinking_enabled: bool
    thinking_effort: str | None


class ChatProviderAdapter(Protocol):
    provider: ProviderId

    def adapt_messages(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        ...

    def adapt_request_body(
        self,
        payload_body: dict[str, object],
        *,
        settings: ChatProviderSettings,
    ) -> dict[str, object]:
        ...

    def extract_message_metadata(
        self,
        message: dict[str, object],
    ) -> dict[str, object]:
        ...


class DefaultChatProviderAdapter:
    provider = ProviderId.COMPATIBLE

    def adapt_messages(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        adapted_messages: list[dict[str, object]] = []
        for message in messages:
            adapted_message = dict(message)
            adapted_message.pop("metadata", None)
            adapted_messages.append(adapted_message)
        return adapted_messages

    def adapt_request_body(
        self,
        payload_body: dict[str, object],
        *,
        settings: ChatProviderSettings,
    ) -> dict[str, object]:
        del settings
        return dict(payload_body)

    def extract_message_metadata(
        self,
        message: dict[str, object],
    ) -> dict[str, object]:
        del message
        return {}


__all__ = [
    "ChatProviderAdapter",
    "ChatProviderSettings",
    "DefaultChatProviderAdapter",
]

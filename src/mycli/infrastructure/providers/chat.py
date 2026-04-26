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
        return [dict(message) for message in messages]

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

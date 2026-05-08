"""Legacy fallback adapter for `legacy_chat` (`chat/completions`) providers."""

from __future__ import annotations

from typing import Protocol

from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import ModelAction, ModelMessage, ModelToolDefinition


class ChatCompletionClient(Protocol):
    def complete(self, messages: list[dict[str, object]]) -> dict[str, object]:
        ...


class CompatChatModelAdapter:
    """Legacy fallback adapter for `legacy_chat` (`chat/completions`) providers."""

    def __init__(self, chat_client: ChatCompletionClient) -> None:
        self._chat_client = chat_client

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        # Legacy chat/completions path has no structured tool schema payload.
        del tools
        payload = self._chat_client.complete(
            [
                {"role": message.role, "content": message.content}
                for message in messages
            ]
        )
        tool_call = None
        if payload.get("tool_name"):
            raw_arguments = payload.get("arguments", {})
            tool_call = ToolCall(
                name=str(payload["tool_name"]),
                arguments=raw_arguments if isinstance(raw_arguments, dict) else {},
                reason=str(payload.get("reason", "model requested tool")),
            )
        return ModelAction(
            assistant_message=(
                None
                if payload.get("assistant_message") is None
                else str(payload["assistant_message"])
            ),
            progress_message=(
                None
                if payload.get("progress_message") is None
                else str(payload["progress_message"])
            ),
            tool_call=tool_call,
            done=bool(payload.get("done", False)),
        )

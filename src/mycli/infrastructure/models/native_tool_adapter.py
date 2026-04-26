"""Legacy fallback adapter for `legacy_chat` providers with tool-call compatibility."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Protocol

from mycli.domain.logging import ModelLogContext
from mycli.domain.tools import ToolCall
from mycli.infrastructure.models.base import (
    ModelAction,
    ModelMessage,
    ModelToolDefinition,
)


class NativeToolClient(Protocol):
    def complete(
        self,
        *,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        ...


class NativeToolModelAdapter:
    """Legacy fallback adapter for `legacy_chat` providers with tool-call compatibility."""

    def __init__(self, client: NativeToolClient) -> None:
        self._client = client

    def set_log_context_provider(
        self,
        provider: Callable[[], ModelLogContext],
    ) -> None:
        setter = getattr(self._client, "set_log_context_provider", None)
        if callable(setter):
            setter(provider)

    def set_thinking_config(self, *, enabled: bool, effort: object) -> None:
        setter = getattr(self._client, "set_thinking_config", None)
        if callable(setter):
            setter(enabled=enabled, effort=effort)

    def next_action(
        self,
        *,
        messages: list[ModelMessage],
        tools: list[ModelToolDefinition],
    ) -> ModelAction:
        payload = self._client.complete(
            messages=[
                {
                    key: value
                    for key, value in {
                        "role": message.role,
                        "content": message.content,
                        "tool_call_id": message.tool_call_id,
                        "tool_calls": (
                            [
                                {
                                    "id": call.call_id,
                                    "type": "function",
                                    "function": {
                                        "name": call.name,
                                        "arguments": json.dumps(call.arguments, ensure_ascii=False),
                                    },
                                }
                                for call in message.tool_calls
                            ]
                            if message.tool_calls
                            else None
                        ),
                    }.items()
                    if value is not None
                }
                for message in messages
            ],
            tools=[
                {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": [
                        {
                            "name": parameter.name,
                            "type": parameter.type,
                            "required": parameter.required,
                            "description": parameter.description,
                        }
                        for parameter in tool.parameters
                    ],
                }
                for tool in tools
            ],
        )
        tool_call = None
        raw_tool_call = payload.get("tool_call")
        if isinstance(raw_tool_call, dict):
            raw_arguments = raw_tool_call.get("arguments", {})
            tool_call = ToolCall(
                name=str(raw_tool_call["name"]),
                arguments=raw_arguments if isinstance(raw_arguments, dict) else {},
                reason=str(raw_tool_call.get("reason", "model requested tool")),
                call_id=(
                    None
                    if raw_tool_call.get("id") is None
                    else str(raw_tool_call["id"])
                ),
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

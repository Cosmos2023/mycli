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
    ModelTurnResult,
)
from mycli.infrastructure.models.turn_event_aggregator import TurnEventAggregator


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
        self._aggregator = TurnEventAggregator()

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
        serialized_messages = self._serialize_messages(messages)
        serialized_tools = self._serialize_tools(tools)
        create_events = getattr(self._client, "create_events", None)
        if callable(create_events):
            turn_result = self._aggregator.collect(
                create_events(input_items=serialized_messages, tools=serialized_tools)
            )
            return self._model_action_from_turn_result(turn_result)

        payload = self._client.complete(
            messages=serialized_messages,
            tools=serialized_tools,
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

    def _serialize_messages(
        self,
        messages: list[ModelMessage],
    ) -> list[dict[str, object]]:
        return [
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
        ]

    def _serialize_tools(
        self,
        tools: list[ModelToolDefinition],
    ) -> list[dict[str, object]]:
        return [
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
        ]

    def _model_action_from_turn_result(self, turn_result: ModelTurnResult) -> ModelAction:
        assistant_item = turn_result.items[0] if turn_result.items else None
        if assistant_item is None:
            return ModelAction(done=turn_result.done)
        text_block = next((block for block in assistant_item.blocks if block.type == "text"), None)
        tool_block = next(
            (block for block in assistant_item.blocks if block.type == "tool_call"),
            None,
        )
        return ModelAction(
            assistant_message=text_block.text if text_block is not None else None,
            progress_message=None,
            tool_call=(
                None
                if tool_block is None
                else ToolCall(
                    name=str(tool_block.tool_name),
                    arguments=tool_block.tool_arguments or {},
                    reason="model requested tool",
                    call_id=tool_block.call_id,
                )
            ),
            done=turn_result.done,
        )

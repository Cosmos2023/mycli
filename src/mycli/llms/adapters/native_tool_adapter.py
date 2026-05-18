"""Chat-completions adapter with native tool-call compatibility."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Protocol, cast

from mycli.domain.logging import ModelLogContext
from mycli.domain.tooling.calls import ToolCall
from mycli.llms.adapters.base import (
    ModelAction,
    ModelMessage,
    ModelToolDefinition,
    ModelTurnResult,
    RuntimeBlock,
    RuntimeItem,
)
from mycli.llms.adapters.turn_event_aggregator import TurnEventAggregator
from mycli.infrastructure.providers import ChatProviderAdapter, DefaultChatProviderAdapter


class NativeToolClient(Protocol):
    def complete(
        self,
        *,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        ...


class NativeToolModelAdapter:
    """Chat-completions adapter with native tool-call compatibility."""

    def __init__(
        self,
        client: NativeToolClient,
        provider_adapter: ChatProviderAdapter | None = None,
    ) -> None:
        self._client = client
        self._provider_adapter = provider_adapter or DefaultChatProviderAdapter()
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

    def set_tool_choice(self, tool_choice: str | None) -> None:
        setter = getattr(self._client, "set_tool_choice", None)
        if callable(setter):
            setter(tool_choice)

    def set_max_output_tokens(self, value: int) -> None:
        setter = getattr(self._client, "set_max_output_tokens", None)
        if callable(setter):
            setter(value)

    def set_model(self, model: str) -> None:
        setter = getattr(self._client, "set_model", None)
        if callable(setter):
            setter(model)

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
        return self._model_action_from_payload(payload)

    def next_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> ModelTurnResult:
        serialized_messages = self._serialize_messages(
            self._messages_from_runtime_items(items)
        )
        serialized_tools = self._serialize_tools(tools)
        create_events = getattr(self._client, "create_events", None)
        if callable(create_events):
            return self._aggregator.collect(
                create_events(input_items=serialized_messages, tools=serialized_tools)
            )

        payload = self._client.complete(
            messages=serialized_messages,
            tools=serialized_tools,
        )
        return self._legacy_action_to_turn_result(
            self._model_action_from_payload(payload)
        )

    def _model_action_from_payload(self, payload: dict[str, object]) -> ModelAction:
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
        serialized_messages = [
            {
                key: value
                for key, value in {
                    "role": message.role,
                    "content": message.content,
                    "tool_call_id": message.tool_call_id,
                    "metadata": message.metadata if message.metadata else None,
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
        adapted_messages = self._provider_adapter.adapt_messages(
            cast("list[dict[str, object]]", serialized_messages)
        )
        return self._sanitize_chat_transcript(adapted_messages)

    def _sanitize_chat_transcript(
        self,
        messages: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        sanitized: list[dict[str, object]] = []
        pending_tool_call_ids: set[str] = set()
        for message in messages:
            role = message.get("role")
            if role == "tool":
                tool_call_id = message.get("tool_call_id")
                if isinstance(tool_call_id, str) and tool_call_id in pending_tool_call_ids:
                    sanitized.append(message)
                    pending_tool_call_ids.remove(tool_call_id)
                continue
            sanitized.append(message)
            if role == "assistant":
                pending_tool_call_ids = self._tool_call_ids(message)
            else:
                pending_tool_call_ids.clear()
        return sanitized

    def _tool_call_ids(self, message: dict[str, object]) -> set[str]:
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            return set()
        ids: set[str] = set()
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            call_id = call.get("id")
            if isinstance(call_id, str):
                ids.add(call_id)
        return ids

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

    def _messages_from_runtime_items(
        self,
        items: list[RuntimeItem],
    ) -> list[ModelMessage]:
        messages: list[ModelMessage] = []
        for item in items:
            if item.role == "tool":
                messages.extend(self._tool_messages_from_runtime_item(item))
                continue
            messages.append(
                ModelMessage(
                    role=item.role,
                    content="\n".join(
                        block.text or ""
                        for block in item.blocks
                        if block.type == "text"
                    ),
                    tool_calls=tuple(
                        ToolCall(
                            name=block.tool_name or "",
                            arguments=block.tool_arguments or {},
                            reason="model requested tool",
                            call_id=block.call_id,
                        )
                        for block in item.blocks
                        if block.type == "tool_call"
                    ),
                    metadata=self._merge_block_metadata(item),
                )
            )
        return messages

    def _tool_messages_from_runtime_item(
        self,
        item: RuntimeItem,
    ) -> list[ModelMessage]:
        messages: list[ModelMessage] = []
        for block in item.blocks:
            if block.type != "tool_result" or not block.call_id:
                continue
            messages.append(
                ModelMessage(
                    role="tool",
                    content=block.text or "",
                    tool_call_id=block.call_id,
                    metadata=dict(block.metadata),
                )
            )
        return messages

    def _merge_block_metadata(self, item: RuntimeItem) -> dict[str, object]:
        merged: dict[str, object] = {}
        for block in item.blocks:
            for key, value in block.metadata.items():
                existing = merged.get(key)
                if isinstance(existing, dict) and isinstance(value, dict):
                    nested = dict(existing)
                    nested.update(value)
                    merged[key] = nested
                    continue
                merged[key] = value
        return merged

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

    def _legacy_action_to_turn_result(self, action: ModelAction) -> ModelTurnResult:
        blocks: list[RuntimeBlock] = []
        if action.progress_message:
            blocks.append(RuntimeBlock(type="reasoning", text=action.progress_message))
        if action.tool_call is not None:
            call = action.tool_call
            blocks.append(
                RuntimeBlock(
                    type="tool_call",
                    tool_name=call.name,
                    tool_arguments=call.arguments,
                    call_id=call.call_id or "call_missing",
                )
            )
        if action.assistant_message:
            blocks.append(RuntimeBlock(type="text", text=action.assistant_message))

        items: tuple[RuntimeItem, ...] = ()
        if blocks:
            items = (RuntimeItem(role="assistant", blocks=tuple(blocks)),)
        return ModelTurnResult(items=items, done=action.done)

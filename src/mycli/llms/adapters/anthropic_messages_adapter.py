from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Protocol, cast

from mycli.domain.logging import ModelLogContext
from mycli.domain.runtime.blocks import ModelTurnResult, RuntimeBlock, RuntimeItem, RuntimeRole
from mycli.domain.tooling.calls import ToolCall
from mycli.utils.provider_replay import deterministic_provider_id
from mycli.llms.adapters.base import (
    ModelAction,
    ModelMessage,
    ModelToolDefinition,
)


class AnthropicMessagesClientProtocol(Protocol):
    def create_message(
        self,
        *,
        system: str | list[dict[str, object]] | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        ...


class AnthropicMessagesModelAdapter:
    def __init__(self, *, client: AnthropicMessagesClientProtocol) -> None:
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
        runtime_items = [
            item
            for message in messages
            if (item := self._runtime_item_from_model_message(message)) is not None
        ]
        result = self.next_turn(items=runtime_items, tools=tools)
        text_block = self._first_block_of_type(result, "text")
        tool_block = self._first_block_of_type(result, "tool_call")
        return ModelAction(
            assistant_message=text_block.text if text_block is not None else None,
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
            done=result.done,
        )

    def next_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> ModelTurnResult:
        system, messages = self._serialize_items(items)
        payload = self._client.create_message(
            system=system,
            messages=messages,
            tools=self._serialize_tools(tools),
        )
        return self._to_turn_result(payload)

    def stream_turn(
        self,
        *,
        items: list[RuntimeItem],
        tools: list[ModelToolDefinition],
    ) -> Iterator[dict[str, object]]:
        system, messages = self._serialize_items(items)
        stream_message = getattr(self._client, "stream_message", None)
        if not callable(stream_message):
            raise AttributeError("client does not support streaming")
        yield from stream_message(
            system=system,
            messages=messages,
            tools=self._serialize_tools(tools),
        )

    def _serialize_items(
        self,
        items: list[RuntimeItem],
    ) -> tuple[str | list[dict[str, object]] | None, list[dict[str, object]]]:
        system_parts: list[dict[str, object]] = []
        system_has_cache_control = False
        messages: list[dict[str, object]] = []
        for item in items:
            if item.role in {"system", "developer"}:
                for block in item.blocks:
                    if block.type != "text" or not block.text:
                        continue
                    system_block: dict[str, object] = {
                        "type": "text",
                        "text": block.text,
                    }
                    if self._item_has_anthropic_breakpoint(item, "system_static"):
                        system_block["cache_control"] = {"type": "ephemeral"}
                        system_has_cache_control = True
                    system_parts.append(system_block)
                continue
            content = self._content_blocks_for_item(item)
            if content:
                messages.append(
                    {"role": self._anthropic_role(item.role), "content": content}
                )
        system: str | list[dict[str, object]] | None
        if not system_parts:
            system = None
        elif system_has_cache_control:
            system = system_parts
        else:
            system = "\n\n".join(str(block["text"]) for block in system_parts)
        return system, messages

    def _anthropic_role(self, role: RuntimeRole) -> str:
        return "user" if role == "tool" else role

    def _content_blocks_for_item(self, item: RuntimeItem) -> list[dict[str, object]]:
        content: list[dict[str, object]] = []
        for block in item.blocks:
            if block.type == "text" and block.text:
                text_block: dict[str, object] = {"type": "text", "text": block.text}
                if self._item_has_anthropic_breakpoint(item, "dynamic_boundary"):
                    text_block["cache_control"] = {"type": "ephemeral"}
                content.append(text_block)
                continue
            if block.type == "tool_call":
                tool_use_id = self._tool_use_id(block)
                content.append(
                    {
                        "type": "tool_use",
                        "id": tool_use_id,
                        "name": str(block.tool_name),
                        "input": block.tool_arguments or {},
                    }
                )
                continue
            if block.type == "tool_result" and block.call_id:
                content.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.call_id,
                        "content": block.text or "",
                    }
                )
                continue
            if block.type == "reasoning" and block.text:
                raw_anthropic_block = block.metadata.get("anthropic")
                if (
                    isinstance(raw_anthropic_block, dict)
                    and raw_anthropic_block.get("type") == "thinking"
                ):
                    content.append(self._anthropic_thinking_block(raw_anthropic_block))
        return content

    def _anthropic_thinking_block(
        self,
        raw_block: dict[object, object],
    ) -> dict[str, object]:
        return {
            str(key): value
            for key, value in raw_block.items()
            if isinstance(key, str)
            and not key.startswith("_")
            and key not in {"cache_control", "provider_state", "responses"}
        }

    def _tool_use_id(self, block: RuntimeBlock) -> str:
        if block.provider_id:
            return block.provider_id
        if block.call_id and block.call_id != "call_missing":
            return block.call_id
        return deterministic_provider_id(
            "toolu",
            {
                "name": block.tool_name,
                "arguments": block.tool_arguments or {},
                "call_id": block.call_id,
            },
        )

    def _item_has_anthropic_breakpoint(
        self,
        item: RuntimeItem,
        breakpoint: str,
    ) -> bool:
        if item.metadata.get("anthropic_cache_control_breakpoint") == breakpoint:
            return True
        policy = item.metadata.get("provider_request_policy")
        if not isinstance(policy, dict):
            return False
        raw_breakpoints = policy.get("anthropic_cache_control_breakpoints")
        if isinstance(raw_breakpoints, tuple):
            return breakpoint in raw_breakpoints
        if isinstance(raw_breakpoints, list):
            return breakpoint in raw_breakpoints
        return False

    def _serialize_tools(
        self,
        tools: list[ModelToolDefinition],
    ) -> list[dict[str, object]]:
        serialized_tools: list[dict[str, object]] = []
        for tool in tools:
            properties: dict[str, object] = {}
            required: list[str] = []
            for parameter in tool.parameters:
                schema: dict[str, object] = {"type": parameter.type}
                if parameter.description is not None:
                    schema["description"] = parameter.description
                if parameter.items_schema is not None:
                    schema["items"] = dict(parameter.items_schema)
                properties[parameter.name] = schema
                if parameter.required:
                    required.append(parameter.name)
            serialized_tools.append(
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": {
                        "type": "object",
                        "properties": properties,
                        "required": required,
                        "additionalProperties": False,
                    },
                }
            )
        return serialized_tools

    def _to_turn_result(self, payload: dict[str, object]) -> ModelTurnResult:
        blocks: list[RuntimeBlock] = []
        raw_content = payload.get("content", [])
        content = raw_content if isinstance(raw_content, list) else []
        has_tool_call = False
        for raw_block in content:
            if not isinstance(raw_block, dict):
                continue
            block_type = raw_block.get("type")
            provider_id = raw_block.get("id")
            provider_id_value = provider_id if isinstance(provider_id, str) else None
            if block_type == "text":
                text = raw_block.get("text")
                if isinstance(text, str) and text:
                    blocks.append(
                        RuntimeBlock(
                            type="text",
                            text=text,
                            provider_id=provider_id_value,
                            metadata={"anthropic": dict(raw_block)},
                        )
                    )
                continue
            if block_type == "thinking":
                thinking = raw_block.get("thinking") or raw_block.get("text")
                if isinstance(thinking, str) and thinking:
                    blocks.append(
                        RuntimeBlock(
                            type="reasoning",
                            text=thinking,
                            provider_id=provider_id_value,
                            metadata={"anthropic": dict(raw_block)},
                        )
                    )
                continue
            if block_type == "tool_use":
                name = raw_block.get("name")
                tool_input = raw_block.get("input", {})
                tool_id = raw_block.get("id")
                if isinstance(name, str) and isinstance(tool_id, str):
                    blocks.append(
                        RuntimeBlock(
                            type="tool_call",
                            tool_name=name,
                            tool_arguments=tool_input if isinstance(tool_input, dict) else {},
                            call_id=tool_id,
                            provider_id=tool_id,
                            source="native",
                            metadata={"anthropic": dict(raw_block)},
                        )
                    )
                    has_tool_call = True
        response_id = payload.get("id")
        usage = payload.get("usage")
        return ModelTurnResult(
            items=(RuntimeItem(role="assistant", blocks=tuple(blocks)),) if blocks else (),
            done=not has_tool_call,
            response_id=response_id if isinstance(response_id, str) else None,
            metadata={"usage": usage} if isinstance(usage, dict) else {},
        )

    def _runtime_item_from_model_message(self, message: ModelMessage) -> RuntimeItem | None:
        if message.role not in {"system", "developer", "user", "assistant", "tool"}:
            return None
        blocks: list[RuntimeBlock] = []
        if message.content:
            blocks.append(RuntimeBlock(type="text", text=message.content))
        for call in message.tool_calls:
            blocks.append(
                RuntimeBlock(
                    type="tool_call",
                    tool_name=call.name,
                    tool_arguments=call.arguments,
                    call_id=call.call_id or call.name,
                )
            )
        if message.tool_call_id and message.role == "tool":
            blocks.append(
                RuntimeBlock(
                    type="tool_result",
                    text=message.content or " ",
                    call_id=message.tool_call_id,
                )
            )
        if not blocks:
            return None
        return RuntimeItem(role=cast(RuntimeRole, message.role), blocks=tuple(blocks))

    def _first_block_of_type(
        self,
        result: ModelTurnResult,
        block_type: str,
    ) -> RuntimeBlock | None:
        for item in result.items:
            for block in item.blocks:
                if block.type == block_type:
                    return block
        return None


__all__ = [
    "AnthropicMessagesClientProtocol",
    "AnthropicMessagesModelAdapter",
]

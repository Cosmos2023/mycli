from __future__ import annotations

from typing import Any, cast

from mycli.domain.conversation import Message
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.session_store import JsonObject
from mycli.domain.tooling.calls import ToolCall


def serialize_message(message: Message) -> JsonObject:
    return {
        "role": message.role,
        "content": message.content,
        "tool_call_id": message.tool_call_id,
        "response_id": message.response_id,
        "metadata": message.metadata,
        "blocks": [serialize_runtime_block(block) for block in message.blocks],
        "tool_calls": [
            {
                "name": call.name,
                "arguments": call.arguments,
                "reason": call.reason,
                "call_id": call.call_id,
            }
            for call in message.tool_calls
        ],
    }


def deserialize_message(payload: JsonObject) -> Message:
    blocks_payload = payload.get("blocks")
    if not isinstance(blocks_payload, list):
        blocks_payload = []
    blocks = tuple(
        deserialize_runtime_block(block_payload)
        for block_payload in blocks_payload
        if isinstance(block_payload, dict)
    )
    content = payload.get("content")
    if not isinstance(content, str):
        content = Message.text_content_from_blocks(blocks)

    tool_calls_payload = payload.get("tool_calls")
    if not isinstance(tool_calls_payload, list):
        tool_calls_payload = []
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    return Message(
        role=cast(Any, str(payload["role"])),
        content=content,
        tool_call_id=optional_str(payload.get("tool_call_id")),
        tool_calls=tuple(
            ToolCall(
                name=str(call["name"]),
                arguments=dict(call["arguments"]),
                reason=str(call["reason"]),
                call_id=optional_str(call.get("call_id")),
            )
            for call in tool_calls_payload
            if isinstance(call, dict)
        ),
        blocks=blocks,
        response_id=optional_str(payload.get("response_id")),
        metadata=dict(metadata),
    )


def serialize_runtime_block(block: RuntimeBlock) -> JsonObject:
    return {
        "type": block.type,
        "text": block.text,
        "tool_name": block.tool_name,
        "tool_arguments": block.tool_arguments,
        "call_id": block.call_id,
        "provider_id": block.provider_id,
        "metadata": block.metadata,
    }


def deserialize_runtime_block(payload: JsonObject) -> RuntimeBlock:
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    tool_arguments = payload.get("tool_arguments")
    if not isinstance(tool_arguments, dict):
        tool_arguments = None

    return RuntimeBlock(
        type=cast(Any, str(payload["type"])),
        text=optional_str(payload.get("text")),
        tool_name=optional_str(payload.get("tool_name")),
        tool_arguments=tool_arguments,
        call_id=optional_str(payload.get("call_id")),
        provider_id=optional_str(payload.get("provider_id")),
        metadata=metadata,
    )


def optional_str(value: object) -> str | None:
    if isinstance(value, str):
        return value
    return None

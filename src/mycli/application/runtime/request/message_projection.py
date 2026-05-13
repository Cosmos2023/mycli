from __future__ import annotations

import json
from typing import Any

from mycli.domain.conversation import Message
from mycli.domain.runtime import ProviderMessageShape, RuntimeBlock
from mycli.domain.tooling.calls import ToolCall


class RequestMessageProjector:
    def render_replay(self, messages: tuple[Message, ...]) -> str:
        return self._join_content(
            f"{message.role}: {self.message_content(message)}"
            for message in messages
            if self.message_content(message)
        )

    def message_content(self, message: Message) -> str:
        if message.blocks and all(block.type == "reasoning" for block in message.blocks):
            return ""
        if message.content:
            return message.content
        if message.blocks:
            text_content = Message.text_content_from_blocks(message.blocks)
            if text_content:
                return text_content
        if message.tool_calls:
            return json.dumps(
                [
                    {
                        "name": call.name,
                        "arguments": call.arguments,
                        "call_id": call.call_id,
                    }
                    for call in message.tool_calls
                ],
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
        return ""

    def runtime_blocks_from_message(self, message: Message) -> tuple[RuntimeBlock, ...]:
        if message.blocks:
            return message.blocks
        if message.role == "assistant":
            blocks: list[RuntimeBlock] = []
            if message.content:
                blocks.append(RuntimeBlock(type="text", text=message.content))
            for call in message.tool_calls:
                if not call.call_id:
                    continue
                blocks.append(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name=call.name,
                        tool_arguments=call.arguments,
                        call_id=call.call_id,
                    )
                )
            return tuple(blocks)
        if message.role == "tool":
            if not message.tool_call_id:
                return ()
            return (
                RuntimeBlock(
                    type="tool_result",
                    text=message.content,
                    call_id=message.tool_call_id,
                ),
            )
        if message.content:
            return (RuntimeBlock(type="text", text=message.content),)
        return ()

    def provider_message_from_replay_message(
        self,
        message: Message,
    ) -> ProviderMessageShape | None:
        content = self.message_content(message)
        tool_calls = self._tool_calls_from_message(message)
        tool_call_id = self._tool_call_id_from_message(message)
        model_metadata = self._message_metadata_from_blocks(message)
        if not content and not tool_calls and not tool_call_id and not model_metadata:
            return None
        metadata: dict[str, Any] = {
            "legacy_content": self._legacy_content_from_message(message, content),
            "model_metadata": model_metadata,
        }
        if tool_call_id:
            metadata["tool_call_id"] = tool_call_id
        if tool_calls:
            metadata["tool_calls"] = tool_calls
        return ProviderMessageShape(
            role=message.role,
            content=content,
            metadata=metadata,
        )

    def _legacy_content_from_message(self, message: Message, content: str) -> str:
        if message.content:
            return message.content
        if any(block.type == "text" for block in message.blocks):
            return content
        if message.role == "tool":
            return content
        return message.content

    def _tool_calls_from_message(self, message: Message) -> tuple[ToolCall, ...]:
        return self.tool_calls_from_message(message)

    def tool_calls_from_message(self, message: Message) -> tuple[ToolCall, ...]:
        if message.tool_calls:
            return message.tool_calls
        return tuple(
            ToolCall(
                name=block.tool_name or "",
                arguments=block.tool_arguments or {},
                reason="model requested tool",
                call_id=block.call_id,
            )
            for block in message.blocks
            if block.type == "tool_call" and block.tool_name and block.call_id
        )

    def _tool_call_id_from_message(self, message: Message) -> str | None:
        if message.tool_call_id:
            return message.tool_call_id
        for block in message.blocks:
            if block.type == "tool_result" and block.call_id:
                return block.call_id
        return None

    def _message_metadata_from_blocks(self, message: Message) -> dict[str, object]:
        metadata: dict[str, object] = {}
        for block in message.blocks:
            for key, value in block.metadata.items():
                existing = metadata.get(key)
                if isinstance(existing, dict) and isinstance(value, dict):
                    nested = dict(existing)
                    nested.update(value)
                    metadata[key] = nested
                    continue
                metadata[key] = value
        return metadata

    def _join_content(self, values: object) -> str:
        if not hasattr(values, "__iter__"):
            return ""
        return "\n".join(str(value) for value in values if str(value).strip())

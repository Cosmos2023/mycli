from __future__ import annotations

from uuid import uuid4

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.tooling.calls import ToolCall


class AssistantConversationRecorder:
    def normalize_tool_call(self, call: ToolCall) -> ToolCall:
        if call.call_id:
            return call
        return ToolCall(
            name=call.name,
            arguments=call.arguments,
            reason=call.reason,
            call_id=f"call_{uuid4().hex}",
        )

    def tool_call_from_block(self, block: RuntimeBlock) -> ToolCall:
        tool_arguments = block.tool_arguments
        return self.normalize_tool_call(
            ToolCall(
                name=block.tool_name or "",
                arguments=tool_arguments if isinstance(tool_arguments, dict) else {},
                reason="model requested tool",
                call_id=block.call_id,
            )
        )

    def record_text_block(
        self,
        conversation: Conversation,
        *,
        block: RuntimeBlock,
        response_id: str | None,
    ) -> None:
        if not block.text:
            return
        conversation.append(
            Message(
                role="assistant",
                content=block.text,
                blocks=(block,),
                response_id=response_id,
            )
        )

    def record_tool_calls(
        self,
        conversation: Conversation,
        *,
        tool_calls: tuple[ToolCall, ...],
        blocks: tuple[RuntimeBlock, ...],
        response_id: str | None = None,
    ) -> None:
        normalized_calls = tuple(self.normalize_tool_call(call) for call in tool_calls)
        conversation.append(
            Message(
                role="assistant",
                content="",
                tool_calls=normalized_calls,
                blocks=blocks,
                response_id=response_id,
            )
        )

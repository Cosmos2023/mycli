from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from mycli.domain.tools import ToolCall

if TYPE_CHECKING:
    from mycli.domain.runtime.blocks import RuntimeBlock

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(slots=True, frozen=True)
class Message:
    role: Role
    content: str
    tool_call_id: str | None = None
    tool_calls: tuple[ToolCall, ...] = field(default_factory=tuple)
    blocks: tuple[RuntimeBlock, ...] = field(default_factory=tuple)
    response_id: str | None = None

    @staticmethod
    def text_content_from_blocks(blocks: tuple[RuntimeBlock, ...]) -> str:
        return "".join(block.text or "" for block in blocks if block.type == "text")


@dataclass(slots=True)
class Conversation:
    session_id: str
    messages: list[Message] = field(default_factory=list)

    def append(self, message: Message) -> None:
        self.messages.append(message)

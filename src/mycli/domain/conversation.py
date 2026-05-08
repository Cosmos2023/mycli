from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from mycli.domain.tooling.calls import ToolCall

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
    metadata: dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def text_content_from_blocks(blocks: tuple[RuntimeBlock, ...]) -> str:
        return "".join(block.text or "" for block in blocks if block.type == "text")


@dataclass(slots=True)
class Conversation:
    session_id: str
    messages: list[Message] = field(default_factory=list)
    parent_id: str | None = None
    fork_point: int | None = None

    def append(self, message: Message) -> None:
        self.messages.append(message)

    def rewind(self, fork_point: int) -> "Conversation":
        if fork_point < 0 or fork_point > len(self.messages):
            raise ValueError("fork_point must be within the conversation message range.")
        return Conversation(
            session_id=self.session_id,
            parent_id=self.parent_id,
            fork_point=fork_point,
            messages=list(self.messages[:fork_point]),
        )

    def fork(self, session_id: str, fork_point: int | None = None) -> "Conversation":
        split_at = len(self.messages) if fork_point is None else fork_point
        if split_at < 0 or split_at > len(self.messages):
            raise ValueError("fork_point must be within the conversation message range.")
        return Conversation(
            session_id=session_id,
            parent_id=self.session_id,
            fork_point=split_at,
            messages=list(self.messages[:split_at]),
        )

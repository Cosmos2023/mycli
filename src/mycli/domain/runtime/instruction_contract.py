from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from mycli.domain.conversation import Message


class InstructionFragmentKind(StrEnum):
    CONVERSATION_CONTEXT = "conversation_context"
    MEMORY = "memory"
    PLAN = "plan"
    RUNTIME_REMINDERS = "runtime_reminders"
    TOOL_EXPOSURE = "tool_exposure"
    WORKSPACE_INSTRUCTIONS = "workspace_instructions"
    ENVIRONMENT_CONTEXT = "environment_context"
    SKILL_CATALOG = "skill_catalog"
    USER_REQUEST = "user_request"


@dataclass(slots=True, frozen=True)
class InstructionFragment:
    kind: InstructionFragmentKind | str
    title: str
    content: str
    source: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    include_in_memory: bool = False


@dataclass(slots=True, frozen=True)
class InstructionContract:
    base_instructions: str
    developer_sections: tuple[InstructionFragment, ...] = ()
    contextual_user_sections: tuple[InstructionFragment, ...] = ()
    conversation_messages: tuple[Message, ...] = ()
    current_user_request: str = ""
    assistant_scaffold: str | None = None

    def memory_excluded_contextual_sections(self) -> tuple[InstructionFragment, ...]:
        return tuple(
            section
            for section in self.contextual_user_sections
            if not section.include_in_memory
        )

    def trace_summary(self) -> dict[str, object]:
        return {
            "base_instruction_present": bool(self.base_instructions),
            "developer_kinds": [str(section.kind) for section in self.developer_sections],
            "contextual_kinds": [str(section.kind) for section in self.contextual_user_sections],
            "memory_excluded_contextual_kinds": [
                str(section.kind)
                for section in self.memory_excluded_contextual_sections()
            ],
            "conversation_message_count": len(self.conversation_messages),
            "current_user_request": self.current_user_request,
        }


__all__ = [
    "InstructionContract",
    "InstructionFragment",
    "InstructionFragmentKind",
]

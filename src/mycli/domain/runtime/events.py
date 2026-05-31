from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

RUNTIME_EVENT_ENVELOPE_VERSION = 1


class RuntimeEventType(StrEnum):
    ASSISTANT_MESSAGE = "assistant_message"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    PLAN_UPDATE = "plan_update"
    APPROVAL_REQUIRED = "approval_required"
    TURN_COMPLETED = "turn_completed"


@dataclass(slots=True, frozen=True)
class RuntimeEvent:
    type: RuntimeEventType
    payload: Any


@dataclass(slots=True, frozen=True)
class RuntimeEventEnvelope:
    sequence: int
    event_type: str
    payload: dict[str, object]
    timestamp: float
    version: int = RUNTIME_EVENT_ENVELOPE_VERSION

    def __post_init__(self) -> None:
        if self.sequence <= 0:
            raise ValueError("RuntimeEventEnvelope sequence must be positive.")
        if not self.event_type.strip():
            raise ValueError("RuntimeEventEnvelope event_type cannot be blank.")
        if self.timestamp < 0:
            raise ValueError("RuntimeEventEnvelope timestamp cannot be negative.")

    def to_dict(self) -> dict[str, object]:
        return {
            "version": self.version,
            "sequence": self.sequence,
            "type": self.event_type,
            "payload": self.payload,
            "timestamp": self.timestamp,
        }

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


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

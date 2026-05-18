from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class TurnStatus(StrEnum):
    IN_PROGRESS = "in_progress"
    WAITING_APPROVAL = "waiting_approval"
    COMPLETED = "completed"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


class StopReason(StrEnum):
    ASSISTANT_COMPLETED = "assistant_completed"
    SUFFICIENT_EVIDENCE = "sufficient_evidence"
    LOOP_DETECTED = "loop_detected"
    APPROVAL_REQUIRED = "approval_required"
    CONTEXT_WINDOW_EXCEEDED = "context_window_exceeded"
    RETRY_EXHAUSTED = "retry_exhausted"
    TRANSPORT_FAILED = "transport_failed"
    RUNTIME_ERROR = "runtime_error"
    MODEL_ERROR = "model_error"


class TurnItemType(StrEnum):
    USER_MESSAGE = "user_message"
    ASSISTANT_MESSAGE = "assistant_message"
    CAPABILITY = "capability"
    TOOL_EXPOSURE = "tool_exposure"
    CONTRIBUTED_TOOL = "contributed_tool"
    REASONING = "reasoning"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    APPROVAL_REQUEST = "approval_request"
    APPROVAL_RESOLUTION = "approval_resolution"
    MODEL_USAGE = "model_usage"
    WARNING = "warning"


@dataclass(slots=True, frozen=True)
class TurnItem:
    type: TurnItemType
    text: str | None = None
    tool_name: str | None = None
    call_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type.value,
            "text": self.text,
            "tool_name": self.tool_name,
            "call_id": self.call_id,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TurnItem":
        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        text = payload.get("text")
        tool_name = payload.get("tool_name")
        call_id = payload.get("call_id")
        return cls(
            type=TurnItemType(str(payload["type"])),
            text=text if isinstance(text, str) else None,
            tool_name=tool_name if isinstance(tool_name, str) else None,
            call_id=call_id if isinstance(call_id, str) else None,
            metadata=metadata,
        )


@dataclass(slots=True, frozen=True)
class TurnRecord:
    thread_id: str
    turn_id: str
    status: TurnStatus
    started_at: str
    completed_at: str | None = None
    stop_reason: StopReason | None = None
    user_message: str | None = None
    items: tuple[TurnItem, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "thread_id": self.thread_id,
            "turn_id": self.turn_id,
            "status": self.status.value,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "stop_reason": None if self.stop_reason is None else self.stop_reason.value,
            "user_message": self.user_message,
            "items": [item.to_dict() for item in self.items],
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TurnRecord":
        raw_items = payload.get("items")
        if not isinstance(raw_items, list):
            raw_items = []
        raw_stop_reason = payload.get("stop_reason")
        stop_reason = None
        if isinstance(raw_stop_reason, str) and raw_stop_reason:
            stop_reason = StopReason(raw_stop_reason)
        user_message = payload.get("user_message")
        completed_at = payload.get("completed_at")
        return cls(
            thread_id=str(payload["thread_id"]),
            turn_id=str(payload["turn_id"]),
            status=TurnStatus(str(payload["status"])),
            started_at=str(payload["started_at"]),
            completed_at=completed_at if isinstance(completed_at, str) else None,
            stop_reason=stop_reason,
            user_message=user_message if isinstance(user_message, str) else None,
            items=tuple(TurnItem.from_dict(item) for item in raw_items if isinstance(item, dict)),
        )


__all__ = [
    "StopReason",
    "TurnItem",
    "TurnItemType",
    "TurnRecord",
    "TurnStatus",
]

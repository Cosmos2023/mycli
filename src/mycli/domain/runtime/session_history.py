from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from mycli.domain.runtime.protocol import StopReason, TurnStatus
from mycli.domain.runtime.compaction_rehydration import InvokedSkillSnapshot


class HistoryItemType(StrEnum):
    USER_MESSAGE = "user_message"
    ASSISTANT_MESSAGE = "assistant_message"
    REASONING = "reasoning"
    SKILL_INSTRUCTIONS = "skill_instructions"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    APPROVAL_REQUEST = "approval_request"
    APPROVAL_RESOLUTION = "approval_resolution"
    WARNING = "warning"
    CAPABILITY = "capability"
    TOOL_EXPOSURE = "tool_exposure"
    CONTRIBUTED_TOOL = "contributed_tool"
    CONTEXT_BASELINE_UPDATE = "context_baseline_update"
    COMPACTION = "compaction"
    FILE_CHANGE = "file_change"
    PLAN_UPDATE = "plan_update"
    COMMAND_RESULT = "command_result"


@dataclass(slots=True, frozen=True)
class HistoryItem:
    id: str
    thread_id: str
    turn_id: str
    type: HistoryItemType
    text: str | None = None
    tool_name: str | None = None
    call_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "thread_id": self.thread_id,
            "turn_id": self.turn_id,
            "type": self.type.value,
            "text": self.text,
            "tool_name": self.tool_name,
            "call_id": self.call_id,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "HistoryItem":
        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        text = payload.get("text")
        tool_name = payload.get("tool_name")
        call_id = payload.get("call_id")
        return cls(
            id=str(payload["id"]),
            thread_id=str(payload["thread_id"]),
            turn_id=str(payload["turn_id"]),
            type=HistoryItemType(str(payload["type"])),
            text=text if isinstance(text, str) else None,
            tool_name=tool_name if isinstance(tool_name, str) else None,
            call_id=call_id if isinstance(call_id, str) else None,
            metadata=metadata,
        )


@dataclass(slots=True, frozen=True)
class BaselineFragment:
    id: str
    kind: str
    title: str
    content: str
    source: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "content": self.content,
            "source": self.source,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "BaselineFragment":
        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        source = payload.get("source")
        return cls(
            id=str(payload["id"]),
            kind=str(payload["kind"]),
            title=str(payload["title"]),
            content=str(payload["content"]),
            source=source if isinstance(source, str) else None,
            metadata=metadata,
        )


@dataclass(slots=True, frozen=True)
class ContextBaseline:
    thread_id: str
    fragments: tuple[BaselineFragment, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "thread_id": self.thread_id,
            "fragments": [fragment.to_dict() for fragment in self.fragments],
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ContextBaseline":
        raw_fragments = payload.get("fragments")
        if not isinstance(raw_fragments, list):
            raw_fragments = []
        return cls(
            thread_id=str(payload["thread_id"]),
            fragments=tuple(
                BaselineFragment.from_dict(fragment)
                for fragment in raw_fragments
                if isinstance(fragment, dict)
            ),
        )


@dataclass(slots=True, frozen=True)
class TurnRolloutEvent:
    event_id: str
    kind: str
    created_at: str
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "kind": self.kind,
            "created_at": self.created_at,
            "payload": self.payload,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TurnRolloutEvent":
        event_payload = payload.get("payload")
        if not isinstance(event_payload, dict):
            event_payload = {}
        return cls(
            event_id=str(payload["event_id"]),
            kind=str(payload["kind"]),
            created_at=str(payload["created_at"]),
            payload=event_payload,
        )


@dataclass(slots=True, frozen=True)
class TurnRollout:
    thread_id: str
    turn_id: str
    status: TurnStatus
    started_at: str
    completed_at: str | None = None
    stop_reason: StopReason | None = None
    events: tuple[TurnRolloutEvent, ...] = ()
    continuation_state: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "thread_id": self.thread_id,
            "turn_id": self.turn_id,
            "status": self.status.value,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "stop_reason": None if self.stop_reason is None else self.stop_reason.value,
            "events": [event.to_dict() for event in self.events],
            "continuation_state": self.continuation_state,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TurnRollout":
        raw_events = payload.get("events")
        if not isinstance(raw_events, list):
            raw_events = []
        raw_stop_reason = payload.get("stop_reason")
        stop_reason = None
        if isinstance(raw_stop_reason, str) and raw_stop_reason:
            stop_reason = StopReason(raw_stop_reason)
        continuation_state = payload.get("continuation_state")
        if not isinstance(continuation_state, dict):
            continuation_state = {}
        completed_at = payload.get("completed_at")
        return cls(
            thread_id=str(payload["thread_id"]),
            turn_id=str(payload["turn_id"]),
            status=TurnStatus(str(payload["status"])),
            started_at=str(payload["started_at"]),
            completed_at=completed_at if isinstance(completed_at, str) else None,
            stop_reason=stop_reason,
            events=tuple(
                TurnRolloutEvent.from_dict(event)
                for event in raw_events
                if isinstance(event, dict)
            ),
            continuation_state=continuation_state,
        )


@dataclass(slots=True, frozen=True)
class SessionRuntimeSnapshot:
    session_id: str
    thread_id: str
    history_items: tuple[HistoryItem, ...] = ()
    context_baseline: ContextBaseline | None = None
    turn_rollouts: tuple[TurnRollout, ...] = ()
    continuation_state: dict[str, Any] = field(default_factory=dict)
    invoked_skills: tuple[InvokedSkillSnapshot, ...] = ()


__all__ = [
    "BaselineFragment",
    "ContextBaseline",
    "HistoryItem",
    "HistoryItemType",
    "SessionRuntimeSnapshot",
    "TurnRollout",
    "TurnRolloutEvent",
]

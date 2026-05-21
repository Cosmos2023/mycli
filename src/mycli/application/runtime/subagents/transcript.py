from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from threading import Lock
from typing import Any, Protocol
from uuid import uuid4

from mycli.domain.runtime import HistoryItem, HistoryItemType


class SupportsHistoryAppend(Protocol):
    def append_history_items(self, session_id: str, items: tuple[HistoryItem, ...]) -> None:
        ...


@dataclass(slots=True)
class SubAgentTranscriptRecorder:
    session_service: SupportsHistoryAppend
    parent_session_id: str
    child_session_id: str
    parent_turn_id: str
    write_lock: Lock | None = None

    def record_system_text(self, text: str) -> None:
        self._append(HistoryItemType.USER_MESSAGE, text=text, metadata={"role": "system"})

    def record_user_text(self, text: str) -> None:
        self._append(HistoryItemType.USER_MESSAGE, text=text)

    def record_assistant_text(self, text: str) -> None:
        self._append(HistoryItemType.ASSISTANT_MESSAGE, text=text)

    def record_tool_call(
        self,
        *,
        call_id: str | None,
        tool_name: str,
        arguments: Mapping[str, Any],
    ) -> None:
        self._append(
            HistoryItemType.TOOL_CALL,
            tool_name=tool_name,
            call_id=call_id,
            metadata={"arguments": dict(arguments)},
        )

    def record_tool_result(
        self,
        *,
        call_id: str | None,
        tool_name: str,
        content: str,
    ) -> None:
        self._append(
            HistoryItemType.TOOL_RESULT,
            text=content,
            tool_name=tool_name,
            call_id=call_id,
        )

    def record_final(self, *, status: str, report: str, tool_calls: int) -> None:
        self._append(
            HistoryItemType.ASSISTANT_MESSAGE,
            text=report,
            metadata={"sub_agent_status": status, "tool_calls": tool_calls},
        )

    def _append(
        self,
        item_type: HistoryItemType,
        *,
        text: str | None = None,
        tool_name: str | None = None,
        call_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        payload = {
            "parent_session_id": self.parent_session_id,
            "parent_turn_id": self.parent_turn_id,
            **(metadata or {}),
        }
        item = HistoryItem(
            id=f"{self.child_session_id}:{uuid4().hex}",
            thread_id=self.child_session_id,
            turn_id=self.parent_turn_id,
            type=item_type,
            text=text,
            tool_name=tool_name,
            call_id=call_id,
            metadata=payload,
        )
        if self.write_lock is None:
            self.session_service.append_history_items(self.child_session_id, (item,))
            return
        with self.write_lock:
            self.session_service.append_history_items(self.child_session_id, (item,))


__all__ = ["SubAgentTranscriptRecorder", "SupportsHistoryAppend"]

from __future__ import annotations

import threading

from mycli.application.runtime.subagents.transcript import SubAgentTranscriptRecorder
from mycli.domain.runtime import HistoryItemType


class FakeSessionService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...]]] = []
        self.active_writes = 0
        self.max_active_writes = 0

    def append_history_items(self, session_id: str, items: tuple[object, ...]) -> None:
        self.active_writes += 1
        self.max_active_writes = max(self.max_active_writes, self.active_writes)
        self.calls.append((session_id, items))
        self.active_writes -= 1


def test_recorder_writes_child_history_items_only() -> None:
    session_service = FakeSessionService()
    recorder = SubAgentTranscriptRecorder(
        session_service=session_service,
        parent_session_id="parent",
        child_session_id="parent:sub:turn_1:abcd",
        parent_turn_id="turn_1",
    )

    recorder.record_user_text("explore repo")
    recorder.record_assistant_text("I will inspect pyproject.")
    recorder.record_tool_call(
        call_id="call_1",
        tool_name="Read",
        arguments={"path": "pyproject.toml"},
    )
    recorder.record_tool_result(
        call_id="call_1",
        tool_name="Read",
        content="name = 'mycli'",
    )
    recorder.record_final(status="completed", report="Project is mycli.", tool_calls=1)

    assert [call[0] for call in session_service.calls] == [
        "parent:sub:turn_1:abcd",
        "parent:sub:turn_1:abcd",
        "parent:sub:turn_1:abcd",
        "parent:sub:turn_1:abcd",
        "parent:sub:turn_1:abcd",
    ]
    items = [call[1][0] for call in session_service.calls]
    assert [item.type for item in items] == [
        HistoryItemType.USER_MESSAGE,
        HistoryItemType.ASSISTANT_MESSAGE,
        HistoryItemType.TOOL_CALL,
        HistoryItemType.TOOL_RESULT,
        HistoryItemType.ASSISTANT_MESSAGE,
    ]
    assert items[0].thread_id == "parent:sub:turn_1:abcd"
    assert items[0].metadata["parent_session_id"] == "parent"
    assert items[2].call_id == "call_1"
    assert items[3].call_id == "call_1"
    assert items[4].metadata["sub_agent_status"] == "completed"
    assert items[4].metadata["tool_calls"] == 1


def test_recorder_uses_write_lock() -> None:
    session_service = FakeSessionService()
    lock = threading.Lock()
    recorder = SubAgentTranscriptRecorder(
        session_service=session_service,
        parent_session_id="parent",
        child_session_id="parent:sub:turn_1:abcd",
        parent_turn_id="turn_1",
        write_lock=lock,
    )

    recorder.record_user_text("explore repo")

    assert session_service.max_active_writes == 1

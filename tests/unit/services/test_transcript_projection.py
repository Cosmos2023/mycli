from __future__ import annotations

from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.services.transcript_projection import (
    SHELL_TRANSCRIPT_MAX_CHARS,
    project_history_item_for_tui,
    project_history_items_for_snapshot,
)


def test_snapshot_projection_keeps_only_tui_visible_history() -> None:
    items = (
        HistoryItem(
            id="user-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.USER_MESSAGE,
            text="inspect the repo",
            metadata={
                "created_at": "2026-07-12T10:00:00Z",
                "provider_blob": "secret",
            },
        ),
        HistoryItem(
            id="baseline-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.CONTEXT_BASELINE_UPDATE,
            text="private environment context",
            metadata={"provider_blob": "secret"},
        ),
    )

    projected = project_history_items_for_snapshot(items)

    assert [item.type for item in projected] == ["user_message"]
    assert projected[0].to_dict() == {
        "id": "user-1",
        "type": "user_message",
        "text": "inspect the repo",
        "created_at": "2026-07-12T10:00:00Z",
    }
    assert "provider_blob" not in str(projected)


def test_snapshot_projection_coalesces_tool_call_and_result() -> None:
    items = (
        HistoryItem(
            id="tool-call-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_CALL,
            text="Running tests",
            tool_name="Bash",
            call_id="call-1",
            metadata={"arguments": {"command": "pytest -q"}},
        ),
        HistoryItem(
            id="tool-result-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_RESULT,
            text="128 passed",
            tool_name="Bash",
            call_id="call-1",
            metadata={
                "exit_code": 0,
                "duration_ms": 4210,
                "provider_id": "tool-private-1",
                "transcript_content": "model-only duplicate",
            },
        ),
    )

    projected = project_history_items_for_snapshot(items)

    assert len(projected) == 1
    assert projected[0].to_dict() == {
        "id": "tool-call-1",
        "type": "command",
        "text": "Running tests",
        "tool_name": "Bash",
        "call_id": "call-1",
        "command": "pytest -q",
        "status": "completed",
        "output": "128 passed",
        "exit_code": 0,
        "duration_ms": 4210,
    }


def test_shell_snapshot_output_uses_head_tail_limit() -> None:
    content = "a" * SHELL_TRANSCRIPT_MAX_CHARS + "middle" + "z" * 32
    projected = project_history_items_for_snapshot(
        (
            HistoryItem(
                id="tool-result-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.TOOL_RESULT,
                text=content,
                tool_name="run_shell",
                call_id="call-1",
            ),
        )
    )

    payload = projected[0].to_dict()
    assert len(str(payload["output"])) <= SHELL_TRANSCRIPT_MAX_CHARS
    assert payload["truncated"] is True
    assert payload["omitted_chars"] > 0
    assert str(payload["output"]).startswith("a")
    assert str(payload["output"]).endswith("z" * 32)


def test_tui_projection_preserves_existing_wire_shape_without_private_metadata() -> None:
    item = HistoryItem(
        id="hist-tool",
        thread_id="demo",
        turn_id="turn-1",
        type=HistoryItemType.TOOL_CALL,
        text="Read pyproject.toml",
        tool_name="Read",
        call_id="call-read-1",
        metadata={
            "created_at": "2026-07-12T10:00:00Z",
            "provider_id": "private",
        },
    )

    assert project_history_item_for_tui(item) == {
        "id": "hist-tool",
        "type": "tool_summary",
        "text": "Read pyproject.toml",
        "created_at": "2026-07-12T10:00:00Z",
        "folded": False,
        "metadata": {"tool_name": "Read", "call_id": "call-read-1"},
    }

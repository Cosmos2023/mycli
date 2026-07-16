from __future__ import annotations

from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.services.transcript_projection import (
    SHELL_TRANSCRIPT_MAX_CHARS,
    project_history_item_for_tui,
    project_history_items_for_tui,
    project_history_items_for_snapshot,
    snapshot_item_to_tui_items,
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


def test_tui_projection_preserves_skill_name_when_coalescing_history() -> None:
    projected = project_history_items_for_tui(
        (
            HistoryItem(
                id="tool-call-skill",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.TOOL_CALL,
                text="Skill",
                tool_name="Skill",
                call_id="call-skill-1",
                metadata={"arguments": {"skill_name": "repository-analysis"}},
            ),
            HistoryItem(
                id="tool-result-skill",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.TOOL_RESULT,
                text="Activated skill: repository-analysis",
                tool_name="Skill",
                call_id="call-skill-1",
                metadata={
                    "success": True,
                    "raw_payload": {"skill_name": "repository-analysis"},
                },
            ),
        )
    )

    assert len(projected) == 1
    assert projected[0]["metadata"]["skill_name"] == "repository-analysis"


def test_snapshot_coalesces_tool_display_without_raw_payload() -> None:
    items = (
        HistoryItem(
            id="call",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_CALL,
            text="Read",
            tool_name="Read",
            call_id="call-1",
            metadata={
                "display": {
                    "target": "src/app.py",
                    "status": "running",
                    "summary": "Reading",
                    "presentation": "context",
                },
                "arguments": {"file_path": "src/app.py"},
            },
        ),
        HistoryItem(
            id="result",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.TOOL_RESULT,
            text="Read complete",
            tool_name="Read",
            call_id="call-1",
            metadata={
                "display": {
                    "status": "success",
                    "summary": "Read 20 lines",
                    "detail": "1\tline",
                    "metrics": {"line_count": 20},
                    "presentation": "context",
                },
                "raw_payload": {"content": "model-only duplicate"},
            },
        ),
    )

    payload = project_history_items_for_snapshot(items)[0].to_dict()
    metadata = payload["metadata"]
    assert isinstance(metadata, dict)
    display = metadata["display"]
    assert isinstance(display, dict)
    assert display["target"] == "src/app.py"
    assert display["status"] == "success"
    assert display["detail"] == "1\tline"
    assert "output" not in payload
    assert "raw_payload" not in str(payload)


def test_tui_projection_ignores_malformed_display_and_keeps_legacy_target() -> None:
    item = HistoryItem(
        id="legacy-read",
        thread_id="demo",
        turn_id="turn-1",
        type=HistoryItemType.TOOL_CALL,
        text="Read src/app.py",
        tool_name="Read",
        call_id="call-read",
        metadata={
            "path": "src/app.py",
            "display": {"status": 42, "summary": ["invalid"]},
        },
    )

    metadata = project_history_item_for_tui(item)["metadata"]
    assert isinstance(metadata, dict)
    assert metadata["path"] == "src/app.py"
    assert "display" not in metadata


def test_shell_projection_keeps_profile_metadata_without_path() -> None:
    item = HistoryItem(
        id="tool-result-shell",
        thread_id="demo",
        turn_id="turn-1",
        type=HistoryItemType.TOOL_RESULT,
        text="ok",
        tool_name="Shell",
        call_id="call-shell",
        metadata={
            "raw_payload": {
                "shell_kind": "powershell",
                "shell_edition": "core",
                "shell_path": "C:/secret/pwsh.exe",
            }
        },
    )

    projected = project_history_item_for_tui(item)
    payload = projected["metadata"]
    assert isinstance(payload, dict)

    assert payload["shell_kind"] == "powershell"
    assert payload["shell_edition"] == "core"
    assert "shell_path" not in payload


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


def test_tui_projection_flattens_bounded_shell_output_without_raw_payload() -> None:
    item = HistoryItem(
        id="hist-shell-result",
        thread_id="demo",
        turn_id="turn-1",
        type=HistoryItemType.TOOL_RESULT,
        text="Bash completed",
        tool_name="Bash",
        call_id="call-shell-1",
        metadata={
            "summary": "duplicate summary",
            "transcript_content": "model-only duplicate",
            "raw_payload": {
                "stdout": "a" * SHELL_TRANSCRIPT_MAX_CHARS + "tail",
                "stderr": "warning",
                "exit_code": 0,
            },
        },
    )

    projected = project_history_item_for_tui(item)
    metadata = projected["metadata"]

    assert isinstance(metadata, dict)
    assert len(str(metadata["output_preview"])) <= SHELL_TRANSCRIPT_MAX_CHARS
    assert str(metadata["output_preview"]).startswith("a")
    assert str(metadata["output_preview"]).endswith("warning")
    assert metadata["truncated"] is True
    assert metadata["omitted_chars"] > 0
    assert metadata["exit_code"] == 0
    assert "raw_payload" not in metadata
    assert "transcript_content" not in metadata
    assert "summary" not in metadata


def test_snapshot_projection_preserves_bounded_file_diff_for_tui_fallback() -> None:
    diff = "--- before\n+++ after\n" + "+changed\n" * 1_500
    projected = project_history_items_for_snapshot(
        (
            HistoryItem(
                id="tool-call-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.TOOL_CALL,
                text="Edit app.py",
                tool_name="Edit",
                call_id="call-edit-1",
                metadata={"arguments": {"file_path": "app.py"}},
            ),
            HistoryItem(
                id="tool-result-1",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.TOOL_RESULT,
                text="Edited app.py",
                tool_name="Edit",
                call_id="call-edit-1",
                metadata={
                    "diff": diff,
                    "file_changes": [{"kind": "Edit", "path": "app.py"}],
                    "success": True,
                },
            ),
        )
    )

    payload = projected[0].to_dict()
    metadata = payload["metadata"]
    assert isinstance(metadata, dict)
    assert len(str(metadata["diff"])) <= SHELL_TRANSCRIPT_MAX_CHARS
    assert metadata["diff_truncated"] is True
    assert metadata["file_changes"] == [{"kind": "Edit", "path": "app.py"}]

    tui_items = snapshot_item_to_tui_items(payload)
    assert tui_items[0]["metadata"]["diff"] == metadata["diff"]
    assert tui_items[0]["metadata"]["file_changes"] == metadata["file_changes"]


def test_snapshot_tool_fallback_maps_completed_status_and_keeps_zero_exit_code() -> None:
    tui_items = snapshot_item_to_tui_items(
        {
            "id": "tool-call-1",
            "type": "command",
            "text": "Run tests",
            "tool_name": "Bash",
            "status": "completed",
            "exit_code": 0,
            "output": "128 passed",
        }
    )

    assert len(tui_items) == 1
    metadata = tui_items[0]["metadata"]
    assert metadata["status"] == "done"
    assert metadata["success"] is True
    assert metadata["exit_code"] == 0
    assert metadata["output_preview"] == "128 passed"


def test_file_change_history_uses_tui_supported_system_notice_type() -> None:
    item = HistoryItem(
        id="file-change-1",
        thread_id="demo",
        turn_id="turn-1",
        type=HistoryItemType.FILE_CHANGE,
        text="Updated app.py",
        metadata={"path": "app.py"},
    )

    assert project_history_item_for_tui(item)["type"] == "system_notice"
    snapshot = project_history_items_for_snapshot((item,))[0].to_dict()
    assert snapshot_item_to_tui_items(snapshot)[0]["type"] == "system_notice"

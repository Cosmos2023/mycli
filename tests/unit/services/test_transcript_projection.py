from __future__ import annotations

from mycli.domain.conversation import Message
from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.services.transcript_projection import (
    SHELL_TRANSCRIPT_MAX_CHARS,
    project_history_item_for_tui,
    project_history_items_for_tui,
    project_history_items_for_snapshot,
    project_messages_for_snapshot,
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


def test_snapshot_projection_hides_internal_turn_aborted_marker() -> None:
    items = (
        HistoryItem(
            id="user-1",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.USER_MESSAGE,
            text="inspect the repo",
        ),
        HistoryItem(
            id="abort-marker",
            thread_id="demo",
            turn_id="turn-1",
            type=HistoryItemType.USER_MESSAGE,
            text="<turn_aborted>internal recovery marker</turn_aborted>",
            metadata={"event_kind": "turn_aborted_marker"},
        ),
    )

    projected = project_history_items_for_snapshot(items)

    assert [item.text for item in projected] == ["inspect the repo"]


def test_message_fallback_hides_internal_turn_aborted_marker() -> None:
    messages = [
        Message(role="user", content="inspect the repo"),
        Message(
            role="user",
            content="<turn_aborted>internal recovery marker</turn_aborted>",
            metadata={"event_kind": "turn_aborted_marker"},
        ),
    ]

    projected = project_messages_for_snapshot(messages)

    assert [item.text for item in projected] == ["inspect the repo"]


def test_legacy_snapshot_hides_persisted_turn_aborted_marker() -> None:
    marker = (
        "<turn_aborted>\n"
        "The user interrupted the previous turn on purpose. Any running tools or "
        "commands may have partially executed.\n"
        "</turn_aborted>"
    )

    projected = snapshot_item_to_tui_items(
        {"id": "abort-marker", "type": "user_message", "text": marker}
    )

    assert projected == ()


def test_command_result_is_excluded_from_durable_transcript_projection() -> None:
    item = HistoryItem(
        id="command-1",
        thread_id="demo",
        turn_id="command-1",
        type=HistoryItemType.COMMAND_RESULT,
        text="Tools - 1 available",
        metadata={
            "command": "/tools",
            "model_visible": False,
            "display": {
                "version": 1,
                "kind": "list",
                "command": "/tools",
                "title": "Tools",
                "severity": "info",
                "rows": [
                    {"key": "Read", "label": "Read", "values": ["file"]}
                ],
            },
            "provider_blob": "private",
        },
    )

    assert project_history_items_for_snapshot((item,)) == ()
    assert project_history_items_for_tui((item,)) == ()


def test_legacy_command_result_snapshot_item_is_hidden_from_tui() -> None:
    assert snapshot_item_to_tui_items(
        {
            "id": "command-legacy",
            "type": "command_result",
            "text": "Tools - 1 available",
            "metadata": {"command": "/tools"},
        }
    ) == ()


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


def test_snapshot_projection_preserves_typed_file_change_display() -> None:
    diff = (
        "--- app.py:before\n"
        "+++ app.py:after\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        "+new\n"
    )
    display = {
        "target": "app.py",
        "status": "success",
        "summary": "Updated",
        "presentation": "mutation",
        "file_changes": [
            {
                "version": 1,
                "kind": "update",
                "path": "app.py",
                "diff": diff,
                "added_lines": 1,
                "removed_lines": 1,
                "language": "py",
            }
        ],
    }
    projected = project_history_items_for_snapshot(
        (
            HistoryItem(
                id="tool-call-typed",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.TOOL_CALL,
                text="Edit app.py",
                tool_name="Edit",
                call_id="call-edit-typed",
                metadata={
                    "arguments": {"file_path": "app.py"},
                    "display": {
                        "target": "app.py",
                        "status": "running",
                        "summary": "Preparing change",
                        "presentation": "mutation",
                    },
                },
            ),
            HistoryItem(
                id="tool-result-typed",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.TOOL_RESULT,
                text="Edited app.py",
                tool_name="Edit",
                call_id="call-edit-typed",
                metadata={"success": True, "display": display},
            ),
        )
    )

    payload = projected[0].to_dict()
    metadata = payload["metadata"]
    assert isinstance(metadata, dict)
    assert metadata["display"] == display
    tui_items = snapshot_item_to_tui_items(payload)
    assert tui_items[0]["metadata"]["display"] == display


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


def test_plan_update_history_projects_to_structured_tui_item() -> None:
    item = HistoryItem(
        id="turn-1:item:2",
        thread_id="demo",
        turn_id="turn-1",
        type=HistoryItemType.PLAN_UPDATE,
        text="Updated Plan",
        metadata={
            "source": "Plan",
            "completed": 1,
            "total": 2,
            "items": [
                {
                    "id": "inspect",
                    "text": "Inspect runtime",
                    "status": "completed",
                },
                {
                    "id": "verify",
                    "text": "Run tests",
                    "status": "in_progress",
                    "evidence": ["focused tests passed"],
                    "private": "drop me",
                },
            ],
            "model_visible": False,
            "provider_blob": "do-not-project",
        },
    )

    snapshot = project_history_items_for_snapshot((item,))[0].to_dict()
    tui_item = snapshot_item_to_tui_items(snapshot)[0]

    assert snapshot == {
        "id": "turn-1:item:2",
        "type": "plan_update",
        "text": "Updated Plan",
        "metadata": {
            "source": "Plan",
            "completed": 1,
            "total": 2,
            "items": [
                {
                    "id": "inspect",
                    "text": "Inspect runtime",
                    "status": "completed",
                },
                {
                    "id": "verify",
                    "text": "Run tests",
                    "status": "in_progress",
                    "evidence": ["focused tests passed"],
                },
            ],
        },
    }
    assert tui_item["type"] == "plan_update"
    assert "provider_blob" not in str(tui_item)
    assert "model_visible" not in str(tui_item)
    assert "private" not in str(tui_item)

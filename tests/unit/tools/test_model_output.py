from __future__ import annotations

from mycli.domain.tooling.calls import ToolResult
from mycli.tools.model_output import mutation_model_output, shell_model_output


def test_running_shell_model_output_uses_stable_response_shape() -> None:
    result = ToolResult(
        success=True,
        summary="Command exited with None",
        raw_payload={
            "background": True,
            "status": "running",
            "process_state": "running_background",
            "shell_id": "7ad20502",
            "chunk_id": "c0ffee12",
            "wall_time_seconds": 0.25,
            "output": "collecting tests...",
        },
    )

    output = shell_model_output(result).text_content()

    assert output == "\n".join(
        (
            "Chunk ID: c0ffee12",
            "Wall time: 0.25 seconds",
            "Process running with session ID 7ad20502",
            "Live output:",
            "collecting tests...",
        )
    )


def test_completed_shell_model_output_reports_exit_code() -> None:
    result = ToolResult(
        success=True,
        summary="Command exited with 0",
        raw_payload={
            "shell_id": "7ad20502",
            "chunk_id": "decafbad",
            "wall_time_seconds": 0.5,
            "terminal_state": "completed",
            "exit_code": 0,
            "output": "done",
        },
    )

    output = shell_model_output(result).text_content()

    assert output == "\n".join(
        (
            "Chunk ID: decafbad",
            "Wall time: 0.50 seconds",
            "Process exited with code 0",
            "Final output:",
            "done",
        )
    )


def test_shell_model_output_applies_per_response_token_budget() -> None:
    result = ToolResult(
        success=True,
        summary="Command exited with 0",
        raw_payload={
            "shell_id": "7ad20502",
            "terminal_state": "completed",
            "exit_code": 0,
            "output": "x" * 1000,
            "max_output_tokens": 20,
        },
    )

    output = shell_model_output(result)

    assert len(output.text_content()) <= 80
    assert "chars omitted" in output.text_content()
    assert result.raw_payload["original_token_count"] > 20
    assert len(str(result.raw_payload["chunk_id"])) == 8


def test_mutation_model_output_returns_compact_file_receipt_without_diff() -> None:
    diff = "--- app.py:before\n+++ app.py:after\n@@ -1 +1 @@\n-old\n+new\n"
    result = ToolResult(
        success=True,
        summary="Edited app.py",
        raw_payload={"path": "app.py", "status": "edited", "diff": diff},
    )

    output = mutation_model_output(result).text_content()

    assert output == "Success. Updated the following files:\nM app.py"
    assert diff not in output


def test_mutation_model_output_reports_add_delete_rename_and_noop() -> None:
    result = ToolResult(
        success=True,
        summary="Updated files",
        raw_payload={
            "file_changes": [
                {"version": 1, "kind": "add", "path": "a.py"},
                {"version": 1, "kind": "delete", "path": "b.py"},
                {
                    "version": 1,
                    "kind": "rename",
                    "path": "new.py",
                    "previous_path": "old.py",
                },
            ]
        },
    )

    assert mutation_model_output(result).text_content() == (
        "Success. Updated the following files:\n"
        "A a.py\n"
        "D b.py\n"
        "R old.py -> new.py"
    )

    unchanged = ToolResult(
        success=True,
        summary="Wrote app.py",
        raw_payload={"path": "app.py", "status": "unchanged"},
    )
    assert mutation_model_output(unchanged).text_content() == "No changes to app.py"


def test_mutation_model_output_returns_actionable_failure_only() -> None:
    result = ToolResult(
        success=False,
        summary="Failed to edit app.py",
        error="expected lines were not found",
        raw_payload={"path": "app.py", "error_kind": "string_not_found"},
    )

    assert mutation_model_output(result).text_content() == (
        "Failed to update app.py: expected lines were not found"
    )

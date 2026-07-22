from __future__ import annotations

import json

import pytest

from mycli.domain.tooling.calls import ToolCall, ToolEvidence, ToolResult
from mycli.services.file_change_display import FileChangeKind
from mycli.services.tool_display import ToolDisplayEnvelope
from mycli.services.tool_display import ToolDisplayProjector


def test_display_envelope_serializes_required_and_non_default_values() -> None:
    envelope = ToolDisplayEnvelope(
        target="src/app.py",
        status="success",
        summary="Updated",
        metrics={"duration_ms": 25, "exit_code": 0},
        presentation="mutation",
    )

    assert envelope.to_dict() == {
        "target": "src/app.py",
        "status": "success",
        "summary": "Updated",
        "metrics": {"duration_ms": 25, "exit_code": 0},
        "presentation": "mutation",
    }


def test_display_envelope_bounds_text_and_scalar_metrics() -> None:
    envelope = ToolDisplayEnvelope.create(
        target="x" * 300,
        status="completed",
        summary="s" * 600,
        detail="head\n" + "d" * 12_000 + "\ntail",
        error="e" * 3_000,
        metrics={
            "duration_ms": 25,
            "nested": {"secret": "ignored"},
            "items": ["ignored"],
        },
        presentation="unknown",
    )

    payload = envelope.to_dict()
    assert payload["status"] == "success"
    assert payload["presentation"] == "tool"
    assert len(str(payload["target"])) <= 240
    assert len(str(payload["summary"])) <= 500
    assert len(str(payload["detail"])) <= 8_000
    assert len(str(payload["error"])) <= 2_000
    assert payload["metrics"] == {"duration_ms": 25}
    assert payload["truncated"] is True
    assert int(payload["omitted_chars"]) > 0
    assert str(payload["detail"]).count("chars omitted") == 1


def test_display_envelope_preserves_existing_truncation_on_round_trip() -> None:
    envelope = ToolDisplayEnvelope.from_mapping(
        {
            "status": "success",
            "summary": "Read complete",
            "detail": "bounded detail",
            "truncated": True,
            "omitted_chars": 42,
            "presentation": "context",
        }
    )

    assert envelope is not None
    assert envelope.to_dict()["truncated"] is True
    assert envelope.to_dict()["omitted_chars"] == 42


def test_display_envelope_rejects_malformed_mapping() -> None:
    assert ToolDisplayEnvelope.from_mapping(None) is None
    assert ToolDisplayEnvelope.from_mapping({"status": 42, "summary": "done"}) is None
    assert ToolDisplayEnvelope.from_mapping({"status": "success", "summary": []}) is None


@pytest.mark.parametrize(
    ("name", "arguments", "payload", "presentation", "target"),
    [
        (
            "Read",
            {"file_path": "src/app.py", "offset": 1, "limit": 200},
            {"content": "1\tline"},
            "context",
            "src/app.py",
        ),
        (
            "Grep",
            {"pattern": "ToolResult", "path": "src"},
            {"matches": []},
            "context",
            "src: ToolResult",
        ),
        (
            "Glob",
            {"pattern": "**/*.py", "path": "src"},
            {"files": ["src/a.py"], "dirs": []},
            "context",
            "src: **/*.py",
        ),
        (
            "LS",
            {"path": "src"},
            {"entries": ["a.py"]},
            "context",
            "src",
        ),
        (
            "Write",
            {"file_path": "notes.md", "content": "a\nb\n"},
            {"path": "notes.md", "status": "written"},
            "mutation",
            "notes.md",
        ),
        (
            "Edit",
            {"file_path": "app.py"},
            {"path": "app.py", "diff": "-a\n+b"},
            "mutation",
            "app.py",
        ),
        (
            "Shell",
            {"command": "pytest -q", "cwd": "/repo"},
            {"stdout": "2 passed", "exit_code": 0},
            "shell",
            "pytest -q",
        ),
        (
            "GitDiff",
            {"path": "src"},
            {"diff": "+line"},
            "mutation",
            "src",
        ),
        (
            "Lint",
            {"paths": "src"},
            {"output": "All checks passed"},
            "diagnostic",
            "src",
        ),
        (
            "WebSearch",
            {"query": "mycli"},
            {"results": []},
            "web",
            "mycli",
        ),
        (
            "WebFetch",
            {"url": "https://example.com"},
            {"content": "Example"},
            "web",
            "https://example.com",
        ),
        (
            "Skill",
            {"skill_name": "repository-analysis"},
            {"skill_name": "repository-analysis"},
            "skill",
            "repository-analysis",
        ),
        (
            "SendMessage",
            {"child_session_id": "child-1", "message": "continue"},
            {"delivery": "queued"},
            "control",
            "child-1",
        ),
    ],
)
def test_projector_classifies_built_in_tools(
    name: str,
    arguments: dict[str, object],
    payload: dict[str, object],
    presentation: str,
    target: str,
) -> None:
    envelope = ToolDisplayProjector().project_result(
        ToolCall(name=name, arguments=arguments, reason="test", call_id="call-1"),
        ToolResult(success=True, summary="done", raw_payload=payload),
        duration_ms=25,
    )

    assert envelope.presentation == presentation
    assert envelope.target == target
    assert envelope.status == "success"
    assert envelope.metrics["duration_ms"] == 25


def test_projector_builds_category_specific_summary_and_detail() -> None:
    projector = ToolDisplayProjector()
    grep = projector.project_result(
        ToolCall(
            name="Grep",
            arguments={"pattern": "ToolResult", "path": "src"},
            reason="test",
        ),
        ToolResult(
            success=True,
            summary="Found 2 matches",
            raw_payload={
                "structured_matches": [
                    {"path": "src/a.py", "line_number": 10, "line": "class ToolResult"},
                    {"path": "src/b.py", "line_number": 20, "line": "ToolResult("},
                ],
                "matches": [{}, {}],
            },
        ),
    )
    edit = projector.project_result(
        ToolCall(name="Edit", arguments={"file_path": "src/a.py"}, reason="test"),
        ToolResult(
            success=True,
            summary="Edited src/a.py",
            raw_payload={
                "path": "src/a.py",
                "status": "edited",
                "diff": "-old\n+new",
                "matches": 1,
            },
        ),
    )

    assert grep.summary == "2 matches"
    assert grep.detail == "src/a.py:10: class ToolResult\nsrc/b.py:20: ToolResult("
    assert grep.metrics["match_count"] == 2
    assert edit.summary == "Updated"
    assert edit.detail is None
    assert edit.file_changes[0].kind is FileChangeKind.UPDATE
    assert edit.file_changes[0].diff == "-old\n+new"
    assert edit.metrics["match_count"] == 1


def test_completed_write_exposes_typed_diff_not_content_detail() -> None:
    call = ToolCall(
        name="Write",
        arguments={"file_path": "app.py", "content": "new\n"},
        reason="test",
        call_id="call-write-1",
    )
    result = ToolResult(
        success=True,
        summary="Wrote app.py",
        raw_payload={
            "path": "app.py",
            "status": "overwritten",
            "diff": "--- app.py:before\n+++ app.py:after\n@@ -1 +1 @@\n-old\n+new\n",
        },
    )

    display = ToolDisplayProjector().project_result(call, result)

    assert display.detail is None
    assert display.file_changes[0].kind is FileChangeKind.UPDATE
    assert display.file_changes[0].added_lines == 1
    assert display.file_changes[0].removed_lines == 1
    assert ToolDisplayEnvelope.from_mapping(display.to_dict()) == display


def test_external_tool_fallback_does_not_copy_unknown_payload() -> None:
    result = ToolResult(
        success=True,
        summary="Fetched record",
        raw_payload={
            "url": "https://example.com/1",
            "content": "visible",
            "provider_blob": {"secret": "must-not-leak"},
        },
        evidence=(
            ToolEvidence(kind="record", title="record-1", snippet="evidence"),
        ),
    )

    envelope = ToolDisplayProjector().project_result(
        ToolCall(
            name="mcp__demo__fetch",
            arguments={"id": "1"},
            reason="test",
        ),
        result,
    )

    assert envelope.presentation == "external"
    assert envelope.target == "https://example.com/1"
    assert envelope.summary == "Fetched record"
    assert envelope.detail == "[record] record-1\n  evidence"
    assert "provider_blob" not in str(envelope.to_dict())
    assert "secret" not in str(envelope.to_dict())


def test_projector_degrades_to_minimal_fallback_for_unexpected_payload_types() -> None:
    envelope = ToolDisplayProjector().project_result(
        ToolCall(
            name="mcp__demo__fetch",
            arguments={"path": {"unexpected": True}},
            reason="test",
        ),
        ToolResult(
            success=False,
            summary="Provider tool failed",
            error="Invalid response",
            raw_payload={"content": object(), "stdout": ["not", "text"]},
        ),
    )

    assert envelope.status == "error"
    assert envelope.summary == "Provider tool failed"
    assert envelope.error == "Invalid response"
    assert envelope.presentation == "external"


def test_projector_keeps_successful_background_shell_running() -> None:
    envelope = ToolDisplayProjector().project_result(
        ToolCall(
            name="Shell",
            arguments={"command": "python worker.py", "run_in_background": True},
            reason="test",
        ),
        ToolResult(
            success=True,
            summary="Shell is running in background",
            raw_payload={
                "status": "running",
                "process_state": "running_background",
                "shell_id": "shell-1",
            },
        ),
    )

    assert envelope.status == "running"
    assert envelope.summary == "Running"


def test_projected_display_stays_within_serialized_budget() -> None:
    envelope = ToolDisplayProjector().project_result(
        ToolCall(
            name="mcp__demo__large",
            arguments={"id": "record-1"},
            reason="test",
        ),
        ToolResult(
            success=False,
            summary="s" * 10_000,
            error="e" * 10_000,
            raw_payload={"content": "d" * 100_000},
        ),
    )

    encoded = json.dumps(envelope.to_dict(), ensure_ascii=False)
    assert len(encoded) <= 12_000
    assert envelope.truncated is True
    assert envelope.omitted_chars > 0

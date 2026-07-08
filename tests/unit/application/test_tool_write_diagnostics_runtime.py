from __future__ import annotations

from mycli.application.runtime.tools.tool_write_diagnostics_runtime import (
    ToolWriteDiagnosticsRuntime,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolResult


def test_write_diagnostics_runtime_attaches_diagnostics_for_successful_write() -> None:
    seen_paths: list[tuple[str, ...]] = []

    def run_diagnostics(paths: tuple[str, ...]) -> dict[str, object]:
        seen_paths.append(paths)
        return {
            "diagnostics": [{"file": "notes.txt", "message": "example"}],
            "count": 1,
            "truncated": False,
        }

    runtime = ToolWriteDiagnosticsRuntime(runner=run_diagnostics)

    result = runtime.with_write_diagnostics_if_needed(
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "after\n"},
            reason="write",
            call_id="call_write_1",
        ),
        result=ToolResult(
            success=True,
            summary="Wrote notes.txt",
            raw_payload={"path": "notes.txt"},
        ),
        effect_profile=ToolEffectProfile(filesystem="write"),
    )

    assert seen_paths == [("notes.txt",)]
    assert result.raw_payload["write_diagnostics"] == {
        "diagnostics": [{"file": "notes.txt", "message": "example"}],
        "count": 1,
        "truncated": False,
    }


def test_write_diagnostics_runtime_skips_failed_or_unchanged_writes() -> None:
    seen_paths: list[tuple[str, ...]] = []
    runtime = ToolWriteDiagnosticsRuntime(
        runner=lambda paths: seen_paths.append(paths) or {"count": 0}
    )

    failed = runtime.with_write_diagnostics_if_needed(
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt"},
            reason="write",
            call_id="call_write_1",
        ),
        result=ToolResult(success=False, summary="Failed", raw_payload={}),
        effect_profile=ToolEffectProfile(filesystem="write"),
    )
    unchanged = runtime.with_write_diagnostics_if_needed(
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt"},
            reason="write",
            call_id="call_write_2",
        ),
        result=ToolResult(
            success=True,
            summary="Unchanged",
            raw_payload={"status": "unchanged", "path": "notes.txt"},
        ),
        effect_profile=ToolEffectProfile(filesystem="write"),
    )

    assert failed.raw_payload == {}
    assert unchanged.raw_payload == {"status": "unchanged", "path": "notes.txt"}
    assert seen_paths == []


def test_write_diagnostics_runtime_records_runner_errors() -> None:
    def run_diagnostics(_paths: tuple[str, ...]) -> dict[str, object]:
        raise RuntimeError("diagnostic backend unavailable")

    runtime = ToolWriteDiagnosticsRuntime(runner=run_diagnostics)

    result = runtime.with_write_diagnostics_if_needed(
        call=ToolCall(
            name="Write",
            arguments={"file_path": "notes.txt", "content": "after\n"},
            reason="write",
            call_id="call_write_1",
        ),
        result=ToolResult(
            success=True,
            summary="Wrote notes.txt",
            raw_payload={"path": "notes.txt"},
        ),
        effect_profile=ToolEffectProfile(filesystem="write"),
    )

    assert result.success is True
    assert result.raw_payload["write_diagnostics"] == {
        "diagnostics": [],
        "count": 0,
        "truncated": False,
        "error": "diagnostic backend unavailable",
    }

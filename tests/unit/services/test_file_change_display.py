from __future__ import annotations

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.services.file_change_display import (
    FILE_CHANGE_MAX_CHARS,
    FILE_CHANGE_MAX_LINES,
    FILE_CHANGE_VERSION,
    FileChangeDisplay,
    FileChangeKind,
    project_file_changes,
)


def _call(name: str, **arguments: object) -> ToolCall:
    return ToolCall(name=name, arguments=dict(arguments), reason="test", call_id="call-1")


def test_projects_created_write_as_add() -> None:
    diff = (
        "--- src/new.py:before\n"
        "+++ src/new.py:after\n"
        "@@ -0,0 +1 @@\n"
        "+x\n"
    )

    changes = project_file_changes(
        _call("Write", file_path="src/new.py", content="x\n"),
        ToolResult(
            success=True,
            summary="Wrote src/new.py",
            raw_payload={
                "path": "src/new.py",
                "status": "created",
                "diff": diff,
            },
        ),
    )

    assert changes == (
        FileChangeDisplay(
            version=FILE_CHANGE_VERSION,
            kind=FileChangeKind.ADD,
            path="src/new.py",
            diff=diff,
            added_lines=1,
            removed_lines=0,
            language="py",
        ),
    )


def test_projects_overwrite_as_update_and_ignores_diff_headers_in_counts() -> None:
    diff = (
        "--- app.py:before\n"
        "+++ app.py:after\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        "+new\n"
    )

    change = project_file_changes(
        _call("Write", file_path="app.py", content="new\n"),
        ToolResult(
            success=True,
            summary="Wrote app.py",
            raw_payload={"path": "app.py", "status": "overwritten", "diff": diff},
        ),
    )[0]

    assert change.kind is FileChangeKind.UPDATE
    assert (change.added_lines, change.removed_lines) == (1, 1)


def test_unchanged_and_failed_results_do_not_claim_file_changes() -> None:
    call = _call("Write", file_path="app.py", content="x")
    unchanged = ToolResult(
        success=True,
        summary="Wrote app.py",
        raw_payload={"path": "app.py", "status": "unchanged", "diff": ""},
    )
    failed = ToolResult(
        success=False,
        summary="Failed to write app.py",
        error="denied",
        raw_payload={"path": "app.py"},
    )

    assert project_file_changes(call, unchanged) == ()
    assert project_file_changes(call, failed) == ()


def test_projection_does_not_infer_operation_from_tool_name_alone() -> None:
    result = ToolResult(
        success=True,
        summary="Wrote app.py",
        raw_payload={"path": "app.py", "diff": "+new\n"},
    )

    assert project_file_changes(_call("Write", file_path="app.py"), result) == ()


def test_structured_rename_round_trips_and_unsupported_versions_are_rejected() -> None:
    payload = {
        "version": FILE_CHANGE_VERSION,
        "kind": "rename",
        "path": "src/new.py",
        "previous_path": "src/old.py",
        "diff": "",
        "added_lines": 0,
        "removed_lines": 0,
        "language": "py",
    }

    change = FileChangeDisplay.from_mapping(payload)

    assert change is not None
    assert change.to_dict() == payload
    assert FileChangeDisplay.from_mapping({**payload, "version": 2}) is None
    assert FileChangeDisplay.from_mapping({**payload, "path": {"bad": True}}) is None


def test_projection_prefers_valid_structured_file_changes() -> None:
    result = ToolResult(
        success=True,
        summary="Updated files",
        raw_payload={
            "status": "patched",
            "file_changes": [
                {
                    "version": FILE_CHANGE_VERSION,
                    "kind": "delete",
                    "path": "src/legacy.py",
                    "diff": "@@ -1 +0,0 @@\n-old\n",
                    "added_lines": 0,
                    "removed_lines": 1,
                },
                {"version": 2, "kind": "update", "path": "ignored.py"},
            ],
        },
    )

    changes = project_file_changes(_call("Patch", file_path="unused.py"), result)

    assert len(changes) == 1
    assert changes[0].kind is FileChangeKind.DELETE
    assert changes[0].path == "src/legacy.py"


def test_large_diff_is_bounded_with_explicit_omission() -> None:
    diff = "@@ -0,0 +1,6000 @@\n" + "".join(
        f"+line {index:04d} {'x' * 40}\n" for index in range(6_000)
    )

    change = project_file_changes(
        _call("Write", file_path="large.py"),
        ToolResult(
            success=True,
            summary="Wrote large.py",
            raw_payload={"path": "large.py", "status": "created", "diff": diff},
        ),
    )[0]

    assert change.truncated is True
    assert change.omitted_chars > 0
    assert "omitted" in change.diff
    assert len(change.diff) <= FILE_CHANGE_MAX_CHARS
    assert len(change.diff.splitlines()) <= FILE_CHANGE_MAX_LINES
    assert change.added_lines == 6_000
    assert change.removed_lines == 0
    assert "+line 0000" in change.diff
    assert "+line 5999" in change.diff

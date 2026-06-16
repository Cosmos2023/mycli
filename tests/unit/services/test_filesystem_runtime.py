from __future__ import annotations

from pathlib import Path

import pytest

from mycli.services.filesystem import FileSystemRuntime, FileSystemRuntimeError
from mycli.tools.edit import EditTool
from mycli.tools.read import ReadTool


def test_filesystem_runtime_records_and_validates_read_snapshot(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "app.py"
    target.write_text("value = 1\n", encoding="utf-8")
    runtime = FileSystemRuntime(workspace_root=workspace)

    runtime.record_read_snapshot(runtime.build_snapshot(target))

    assert runtime.validate_recent_read_snapshot(target).ok is True

    target.write_text("value = 2\n", encoding="utf-8")
    validation = runtime.validate_recent_read_snapshot(target)

    assert validation.ok is False
    assert validation.error_kind == "stale_read_snapshot"


def test_filesystem_runtime_rejects_missing_read_snapshot(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "app.py"
    target.write_text("value = 1\n", encoding="utf-8")
    runtime = FileSystemRuntime(workspace_root=workspace)

    validation = runtime.validate_recent_read_snapshot(target)

    assert validation.ok is False
    assert validation.error_kind == "missing_read_snapshot"


def test_filesystem_runtime_writes_full_content_with_diff(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "notes.txt"
    target.write_text("old\n", encoding="utf-8")
    runtime = FileSystemRuntime(workspace_root=workspace)

    result = runtime.write_full_content(target=target, content="new\n")

    assert result.status == "overwritten"
    assert "-old" in result.diff
    assert "+new" in result.diff
    assert target.read_text(encoding="utf-8") == "new\n"


def test_filesystem_runtime_allows_explicit_memory_root(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    memory = tmp_path / "home" / ".mycli" / "projects" / "demo" / "memory"
    workspace.mkdir(parents=True)
    memory.mkdir(parents=True)
    runtime = FileSystemRuntime(workspace_root=workspace, allowed_roots=(memory,))

    target = runtime.resolve_path(str(memory / "MEMORY.md"))
    result = runtime.write_full_content(target=target, content="- [Tone](tone.md) - terse\n")

    assert result.status == "created"
    assert (memory / "MEMORY.md").read_text(encoding="utf-8") == "- [Tone](tone.md) - terse\n"
    assert runtime.relative_path(memory / "MEMORY.md") == "memory/MEMORY.md"


def test_filesystem_runtime_still_rejects_non_memory_workspace_escape(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    memory = tmp_path / "home" / ".mycli" / "projects" / "demo" / "memory"
    workspace.mkdir(parents=True)
    memory.mkdir(parents=True)
    runtime = FileSystemRuntime(workspace_root=workspace, allowed_roots=(memory,))

    with pytest.raises(ValueError):
        runtime.resolve_path(str(tmp_path / "outside.txt"))


def test_filesystem_runtime_replace_text_reports_stable_error_kind(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "notes.txt"
    target.write_text("x = 1\nx = 1\n", encoding="utf-8")
    runtime = FileSystemRuntime(workspace_root=workspace)

    with pytest.raises(FileSystemRuntimeError) as exc_info:
        runtime.replace_text(target=target, old_string="x = 1", new_string="x = 2")

    assert exc_info.value.error_kind == "multiple_matches"


def test_filesystem_runtime_rejects_secret_like_direct_write(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = FileSystemRuntime(workspace_root=workspace)

    with pytest.raises(FileSystemRuntimeError) as exc_info:
        runtime.write_full_content(
            target=workspace / "secret.txt",
            content="API_KEY = 'sk-1234567890abcdef'\n",
        )

    assert exc_info.value.error_kind == "secret_like_content"
    assert not (workspace / "secret.txt").exists()


def test_filesystem_runtime_strips_read_line_numbers_for_exact_edit(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "app.py"
    target.write_text("def value():\n    return 1\n", encoding="utf-8")
    runtime = FileSystemRuntime(workspace_root=workspace)

    mutation, matches = runtime.replace_text(
        target=target,
        old_string="     1\tdef value():\n     2\t    return 1",
        new_string="def value():\n    return 2",
    )

    assert matches == 1
    assert mutation.status == "edited"
    assert target.read_text(encoding="utf-8") == "def value():\n    return 2\n"


def test_read_and_edit_tools_share_filesystem_runtime_snapshot(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "notes.txt"
    target.write_text("old value\n", encoding="utf-8")
    runtime = FileSystemRuntime(workspace_root=workspace)

    read_result = ReadTool(workspace, filesystem_runtime=runtime).execute(
        {"file_path": "notes.txt"}
    )
    edit_result = EditTool(workspace, filesystem_runtime=runtime).execute(
        {
            "file_path": "notes.txt",
            "old_string": "old value",
            "new_string": "new value",
        }
    )

    assert read_result.success is True
    assert edit_result.success is True
    assert target.read_text(encoding="utf-8") == "new value\n"

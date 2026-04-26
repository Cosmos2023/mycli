from pathlib import Path

from mycli.domain.tools import ToolCall
from mycli.tools.append_file import AppendFileTool
from mycli.tools.read_file_range import ReadFileRangeTool
from mycli.tools.replace_in_file import ReplaceInFileTool


def test_read_file_range_reads_inclusive_line_slice(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "notes.txt").write_text("a\nb\nc\nd\n", encoding="utf-8")

    tool = ReadFileRangeTool(root)
    result = tool.run(
        ToolCall(
            name="read_file_range",
            arguments={"path": "notes.txt", "start_line": 2, "end_line": 3},
            reason="inspect snippet",
        )
    )

    assert result.success is True
    assert result.raw_payload["content"] == "b\nc\n"
    assert result.raw_payload["actual_start_line"] == 2
    assert result.raw_payload["actual_end_line"] == 3


def test_read_file_range_exposes_line_scoped_file_excerpt_evidence(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "notes.txt").write_text("a\nb\nc\nd\n", encoding="utf-8")

    tool = ReadFileRangeTool(root)
    result = tool.run(
        ToolCall(
            name="read_file_range",
            arguments={"path": "notes.txt", "start_line": 2, "end_line": 3},
            reason="inspect snippet",
        )
    )

    assert result.success is True
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.kind == "file_excerpt"
    assert evidence.title == "notes.txt:2-3"
    assert evidence.path == "notes.txt"
    assert evidence.line_start == 2
    assert evidence.line_end == 3
    assert evidence.snippet == "b\nc\n"


def test_read_file_range_rejects_workspace_escape(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    tool = ReadFileRangeTool(root)
    result = tool.run(
        ToolCall(
            name="read_file_range",
            arguments={"path": "../secret.txt", "start_line": 1, "end_line": 1},
            reason="inspect snippet",
        )
    )

    assert result.success is False
    assert result.error is not None
    assert "workspace" in result.error.lower()


def test_append_file_appends_text_to_existing_file(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "notes.txt").write_text("hello", encoding="utf-8")

    tool = AppendFileTool(root)
    result = tool.run(
        ToolCall(
            name="append_file",
            arguments={"path": "notes.txt", "content": " world"},
            reason="update note",
        )
    )

    assert result.success is True
    assert (root / "notes.txt").read_text(encoding="utf-8") == "hello world"
    assert result.raw_payload["created"] is False


def test_append_file_creates_missing_file_when_parent_exists(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    tool = AppendFileTool(root)
    result = tool.run(
        ToolCall(
            name="append_file",
            arguments={"path": "new.txt", "content": "hello\n"},
            reason="create note",
        )
    )

    assert result.success is True
    assert (root / "new.txt").read_text(encoding="utf-8") == "hello\n"
    assert result.raw_payload["created"] is True


def test_replace_in_file_replaces_exact_text(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "config.txt").write_text("mode=dev\n", encoding="utf-8")

    tool = ReplaceInFileTool(root)
    result = tool.run(
        ToolCall(
            name="replace_in_file",
            arguments={
                "path": "config.txt",
                "old_text": "mode=dev",
                "new_text": "mode=prod",
                "expected_count": 1,
            },
            reason="promote config",
        )
    )

    assert result.success is True
    assert (root / "config.txt").read_text(encoding="utf-8") == "mode=prod\n"
    assert result.raw_payload["replacement_count"] == 1


def test_replace_in_file_refuses_mismatched_expected_count(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "config.txt").write_text("x\nx\n", encoding="utf-8")

    tool = ReplaceInFileTool(root)
    result = tool.run(
        ToolCall(
            name="replace_in_file",
            arguments={
                "path": "config.txt",
                "old_text": "x",
                "new_text": "y",
                "expected_count": 1,
            },
            reason="replace exact count",
        )
    )

    assert result.success is False
    assert result.error is not None
    assert "expected_count" in result.error
    assert (root / "config.txt").read_text(encoding="utf-8") == "x\nx\n"

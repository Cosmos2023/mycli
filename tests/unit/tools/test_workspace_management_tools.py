from pathlib import Path

from mycli.domain.tools import ToolCall
from mycli.tools.create_file import CreateFileTool
from mycli.tools.delete_path import DeletePathTool
from mycli.tools.mkdir import MkdirTool
from mycli.tools.move_path import MovePathTool


def test_create_file_writes_utf8_text(tmp_path: Path) -> None:
    tool = CreateFileTool(tmp_path)

    result = tool.run(
        ToolCall(
            name="create_file",
            arguments={"path": "notes.txt", "content": "hello\n"},
            reason="create note",
        )
    )

    assert result.success is True
    assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "hello\n"


def test_mkdir_creates_nested_directory(tmp_path: Path) -> None:
    tool = MkdirTool(tmp_path)

    result = tool.run(
        ToolCall(
            name="mkdir",
            arguments={"path": "docs/specs"},
            reason="prepare docs",
        )
    )

    assert result.success is True
    assert (tmp_path / "docs" / "specs").is_dir()


def test_move_path_moves_file_within_workspace(tmp_path: Path) -> None:
    (tmp_path / "old.txt").write_text("hello\n", encoding="utf-8")
    tool = MovePathTool(tmp_path)

    result = tool.run(
        ToolCall(
            name="move_path",
            arguments={"source": "old.txt", "destination": "archive/new.txt"},
            reason="reorganize file",
        )
    )

    assert result.success is True
    assert not (tmp_path / "old.txt").exists()
    assert (tmp_path / "archive" / "new.txt").read_text(encoding="utf-8") == "hello\n"


def test_delete_path_removes_file(tmp_path: Path) -> None:
    (tmp_path / "trash.txt").write_text("bye\n", encoding="utf-8")
    tool = DeletePathTool(tmp_path)

    result = tool.run(
        ToolCall(
            name="delete_path",
            arguments={"path": "trash.txt"},
            reason="clean up file",
        )
    )

    assert result.success is True
    assert not (tmp_path / "trash.txt").exists()

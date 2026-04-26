from pathlib import Path

from mycli.domain.tools import ToolCall
from mycli.tools.edit_file import EditFileTool


def test_edit_file_tool_returns_diff_preview(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "notes.txt").write_text("old line\n", encoding="utf-8")

    tool = EditFileTool(root)
    result = tool.run(
        ToolCall(
            name="edit_file",
            arguments={"path": "notes.txt", "new_content": "new line\n"},
            reason="update text",
        )
    )

    assert result.success is True
    assert "--- notes.txt" in result.raw_payload["diff"]

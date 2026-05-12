from pathlib import Path

from mycli.domain.tools import ToolCall
from mycli.tools.write import WriteTool


def test_write_tool_overwrites_existing_file(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "notes.txt").write_text("old line\n", encoding="utf-8")

    tool = WriteTool(root)
    result = tool.run(
        ToolCall(
            name="Write",
            arguments={"path": "notes.txt", "new_content": "new line\n"},
            reason="update text",
        )
    )

    assert result.success is True
    assert result.raw_payload["status"] == "overwritten"
    assert (root / "notes.txt").read_text(encoding="utf-8") == "new line\n"

from pathlib import Path

from mycli.domain.tools import ToolCall
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.tools.file_snapshot import FileSnapshotStore
from mycli.tools.patch import PatchTool
from mycli.tools.read import ReadTool
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
    assert "diff" in result.raw_payload
    assert (root / "notes.txt").read_text(encoding="utf-8") == "new line\n"


def test_write_tool_rejects_secret_like_content(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    result = WriteTool(root).execute(
        {"file_path": "secret.txt", "content": "API_KEY = 'sk-1234567890abcdef'\n"}
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "secret_like_content"
    assert not (root / "secret.txt").exists()


def test_write_tool_rejects_binary_existing_file(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "blob.bin").write_bytes(b"\x00\x01\x02")

    result = WriteTool(root).execute({"file_path": "blob.bin", "content": "text"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "binary_file"


def test_write_tool_rejects_stale_expected_sha256(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "notes.txt"
    target.write_text("old\n", encoding="utf-8")
    snapshot = ReadTool(root).execute({"file_path": "notes.txt"}).raw_payload["snapshot"]
    target.write_text("changed\n", encoding="utf-8")

    result = WriteTool(root).execute(
        {
            "file_path": "notes.txt",
            "content": "new\n",
            "expected_sha256": snapshot["sha256"],
        }
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "stale_write_snapshot"
    assert target.read_text(encoding="utf-8") == "changed\n"


def test_patch_tool_applies_exact_replacement_after_read_snapshot(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "app.py"
    target.write_text("value = 1\n", encoding="utf-8")
    store = FileSnapshotStore()
    ReadTool(root, snapshot_store=store).execute({"file_path": "app.py"})

    result = PatchTool(root, snapshot_store=store).execute(
        {"file_path": "app.py", "old_string": "value = 1", "new_string": "value = 2"}
    )
    rendered = ToolResultFormatter().format("Patch", result)

    assert result.success is True
    assert result.raw_payload["status"] == "patched"
    assert result.raw_payload["matches"] == 1
    assert "Diff preview" in rendered
    assert target.read_text(encoding="utf-8") == "value = 2\n"


def test_patch_tool_reports_repeated_matches_with_actionable_error(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "app.py").write_text("x = 1\nx = 1\n", encoding="utf-8")
    store = FileSnapshotStore()
    ReadTool(root, snapshot_store=store).execute({"file_path": "app.py"})

    result = PatchTool(root, snapshot_store=store).execute(
        {"file_path": "app.py", "old_string": "x = 1", "new_string": "x = 2"}
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "multiple_matches"
    assert "surrounding context" in result.error


def test_patch_tool_rejects_stale_read_snapshot(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "app.py"
    target.write_text("value = 1\n", encoding="utf-8")
    store = FileSnapshotStore()
    ReadTool(root, snapshot_store=store).execute({"file_path": "app.py"})
    target.write_text("value = 3\n", encoding="utf-8")

    result = PatchTool(root, snapshot_store=store).execute(
        {"file_path": "app.py", "old_string": "value = 3", "new_string": "value = 4"}
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "stale_read_snapshot"

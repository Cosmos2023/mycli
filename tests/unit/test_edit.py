from mycli.tools.edit import EditTool
from mycli.tools.file_snapshot import FileSnapshotStore
from mycli.tools.read import ReadTool


def test_edit_tool_requires_prior_read_snapshot(tmp_path):
    f = tmp_path / "test.py"
    f.write_text("value = 1\n", encoding="utf-8")
    tool = EditTool(tmp_path)

    result = tool.execute(
        {"file_path": "test.py", "old_string": "value = 1", "new_string": "value = 2"}
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "missing_read_snapshot"
    assert "Read" in result.error


def test_edit_tool_allows_edit_after_read_snapshot(tmp_path):
    f = tmp_path / "test.py"
    f.write_text("value = 1\n", encoding="utf-8")
    store = FileSnapshotStore()
    ReadTool(tmp_path, snapshot_store=store).execute(
        {"file_path": "test.py", "offset": 1, "limit": 200}
    )
    tool = EditTool(tmp_path, snapshot_store=store)

    result = tool.execute(
        {"file_path": "test.py", "old_string": "value = 1", "new_string": "value = 2"}
    )

    assert result.success is True
    assert f.read_text(encoding="utf-8") == "value = 2\n"


def test_edit_tool_rejects_file_changed_since_read(tmp_path):
    f = tmp_path / "test.py"
    f.write_text("value = 1\n", encoding="utf-8")
    store = FileSnapshotStore()
    ReadTool(tmp_path, snapshot_store=store).execute(
        {"file_path": "test.py", "offset": 1, "limit": 200}
    )
    f.write_text("value = 3\n", encoding="utf-8")
    tool = EditTool(tmp_path, snapshot_store=store)

    result = tool.execute(
        {"file_path": "test.py", "old_string": "value = 3", "new_string": "value = 4"}
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "stale_read_snapshot"
    assert result.error == "File changed since last Read. Re-read the file and retry."


def test_edit_tool_rejects_secret_like_new_content(tmp_path):
    f = tmp_path / "test.py"
    f.write_text("TOKEN = ''\n", encoding="utf-8")
    store = FileSnapshotStore()
    ReadTool(tmp_path, snapshot_store=store).execute(
        {"file_path": "test.py", "offset": 1, "limit": 200}
    )
    tool = EditTool(tmp_path, snapshot_store=store)

    result = tool.execute(
        {
            "file_path": "test.py",
            "old_string": "TOKEN = ''",
            "new_string": "TOKEN = 'sk-1234567890abcdef'",
        }
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "secret_like_content"
    assert "secret" in result.error.lower()


def test_edit_tool_rejects_oversized_file(monkeypatch, tmp_path):
    f = tmp_path / "large.txt"
    f.write_text("x" * 10, encoding="utf-8")
    store = FileSnapshotStore()
    ReadTool(tmp_path, snapshot_store=store).execute(
        {"file_path": "large.txt", "offset": 1, "limit": 200}
    )
    monkeypatch.setattr("mycli.tools.edit.MAX_EDIT_FILE_BYTES", 5)
    tool = EditTool(tmp_path, snapshot_store=store)

    result = tool.execute(
        {"file_path": "large.txt", "old_string": "x", "new_string": "y", "replace_all": True}
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "file_too_large"

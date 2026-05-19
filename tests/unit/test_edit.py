import pytest

from mycli.tools.edit import EditError, EditTool, edit_file
from mycli.tools.file_snapshot import FileSnapshotStore
from mycli.tools.read import ReadTool


class TestEdit:
    def test_basic_replace(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("hello = 'world'\n")

        edit_file(str(f), "hello = 'world'", "hello = 'universe'")

        assert f.read_text() == "hello = 'universe'\n"

    def test_unique_match_required(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("x = 1\nx = 1\n")

        with pytest.raises(EditError, match="Multiple matches"):
            edit_file(str(f), "x = 1", "x = 2")

    def test_zero_match(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("hello\n")

        with pytest.raises(EditError, match="String not found"):
            edit_file(str(f), "nonexistent", "replacement")

    def test_append_to_file_end(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def foo():\n    pass\n}\n")

        edit_file(str(f), "}", "}\ndef bar():\n    pass\n")

        assert "def bar():" in f.read_text()

    def test_delete(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("line1\nline2\nline3\n")

        edit_file(str(f), "line2\n", "")

        assert f.read_text() == "line1\nline3\n"

    def test_replace_all(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("foo\nbar\nfoo\n")

        edit_file(str(f), "foo", "baz", replace_all=True)

        assert f.read_text() == "baz\nbar\nbaz\n"

    def test_file_not_found_with_nonempty_old(self, tmp_path):
        with pytest.raises(EditError, match="File does not exist"):
            edit_file(str(tmp_path / "nope.py"), "something", "else")

    def test_empty_old_creates_file(self, tmp_path):
        f = tmp_path / "new.py"

        edit_file(str(f), "", "#!/usr/bin/env python\n")

        assert f.exists()
        assert f.read_text() == "#!/usr/bin/env python\n"

    def test_empty_old_with_existing_content(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("existing\n")

        with pytest.raises(EditError, match="File has existing content"):
            edit_file(str(f), "", "new content")

    def test_line_number_stripping(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def foo():\n    return 1\n")

        edit_file(
            str(f),
            "     1\tdef foo():\n     2\t    return 1",
            "def foo():\n    return 42",
        )

        assert "return 42" in f.read_text()


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
    ReadTool(tmp_path, snapshot_store=store).execute({"file_path": "test.py"})
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
    ReadTool(tmp_path, snapshot_store=store).execute({"file_path": "test.py"})
    f.write_text("value = 3\n", encoding="utf-8")
    tool = EditTool(tmp_path, snapshot_store=store)

    result = tool.execute(
        {"file_path": "test.py", "old_string": "value = 3", "new_string": "value = 4"}
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "stale_read_snapshot"
    assert result.error == "File changed since last Read. Re-read the file and retry."


def test_edit_file_rejects_no_op(tmp_path):
    f = tmp_path / "test.py"
    f.write_text("value = 1\n", encoding="utf-8")

    with pytest.raises(EditError, match="no-op"):
        edit_file(str(f), "value = 1", "value = 1")


def test_edit_tool_rejects_secret_like_new_content(tmp_path):
    f = tmp_path / "test.py"
    f.write_text("TOKEN = ''\n", encoding="utf-8")
    store = FileSnapshotStore()
    ReadTool(tmp_path, snapshot_store=store).execute({"file_path": "test.py"})
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
    ReadTool(tmp_path, snapshot_store=store).execute({"file_path": "large.txt"})
    monkeypatch.setattr("mycli.tools.edit.MAX_EDIT_FILE_BYTES", 5)
    tool = EditTool(tmp_path, snapshot_store=store)

    result = tool.execute(
        {"file_path": "large.txt", "old_string": "x", "new_string": "y", "replace_all": True}
    )

    assert result.success is False
    assert result.raw_payload["error_kind"] == "file_too_large"

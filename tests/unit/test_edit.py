import pytest

from mycli.tools.edit import EditError, edit_file


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

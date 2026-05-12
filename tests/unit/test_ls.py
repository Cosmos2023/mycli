import pytest

from mycli.tools.ls import LSError, ls


class TestLS:
    def test_lists_contents(self, tmp_path):
        (tmp_path / "file.py").write_text("")
        (tmp_path / "subdir").mkdir()

        result = ls(str(tmp_path))

        assert "file.py" in result["files"]
        assert "subdir" in result["dirs"]

    def test_hidden_files_listed(self, tmp_path):
        (tmp_path / ".env").write_text("KEY=val")

        result = ls(str(tmp_path))

        assert ".env" in result.get("hidden", [])

    def test_absolute_path_required(self):
        with pytest.raises(LSError, match="Absolute path"):
            ls("relative/path")

    def test_not_a_directory(self, tmp_path):
        f = tmp_path / "file.txt"
        f.write_text("hello")

        with pytest.raises(LSError, match="Not a directory"):
            ls(str(f))

from mycli.tools.glob import glob


class TestGlob:
    def test_finds_files(self, tmp_path):
        (tmp_path / "a.py").write_text("")
        (tmp_path / "b.py").write_text("")
        (tmp_path / "c.txt").write_text("")

        result = glob("*.py", path=str(tmp_path))

        assert len(result["files"]) == 2
        assert result["truncated"] is False

    def test_recursive_double_star(self, tmp_path):
        d = tmp_path / "sub"
        d.mkdir()
        (d / "x.py").write_text("")

        result = glob("**/*.py", path=str(tmp_path))

        assert len(result["files"]) == 1

    def test_truncated_at_200(self, tmp_path):
        for i in range(250):
            (tmp_path / f"f{i}.py").write_text("")

        result = glob("*.py", path=str(tmp_path))

        assert result["truncated"] is True
        assert result["count"] == 200

    def test_sorted_by_mtime(self, tmp_path):
        import time

        f1 = tmp_path / "old.py"
        f1.write_text("")
        time.sleep(0.1)
        f2 = tmp_path / "new.py"
        f2.write_text("")

        result = glob("*.py", path=str(tmp_path))

        assert result["files"][0] == "new.py"

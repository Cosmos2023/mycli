from mycli.tools.grep import grep


class TestGrep:
    def test_files_with_matches_default(self, tmp_path):
        f1 = tmp_path / "a.py"
        f1.write_text("def login():\n    pass\n")
        f2 = tmp_path / "b.py"
        f2.write_text("print('hello')\n")

        result = grep("login", path=str(tmp_path))

        assert result["mode"] == "files_with_matches"
        assert "a.py" in str(result["matches"])
        assert "b.py" not in str(result["matches"])

    def test_content_mode(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def login():\n    pass\n")

        result = grep("login", path=str(tmp_path), output_mode="content", context=2)

        assert "def login():" in str(result["matches"])

    def test_truncated_flag(self, tmp_path):
        d = tmp_path / "many"
        d.mkdir()
        for i in range(60):
            (d / f"f{i}.py").write_text(f"login_{i}()\n")

        result = grep("login", path=str(d), head_limit=50)

        assert result["truncated"] is True

    def test_case_insensitive(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("Login()\n")

        result = grep("login", path=str(tmp_path), ignore_case=True)

        assert "test.py" in str(result["matches"])

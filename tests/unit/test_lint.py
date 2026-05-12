from unittest.mock import patch

from mycli.tools.lint import _detect_linters, lint


class TestLint:
    def test_detect_python(self, tmp_path, monkeypatch):
        (tmp_path / "pyproject.toml").write_text("[tool.ruff]")
        monkeypatch.chdir(tmp_path)

        linters = _detect_linters()

        assert any("ruff" in cmd for cmd in linters)

    def test_detect_javascript(self, tmp_path, monkeypatch):
        (tmp_path / "package.json").write_text('{"name": "test"}')
        monkeypatch.chdir(tmp_path)

        linters = _detect_linters()

        assert any("eslint" in cmd for cmd in linters)

    def test_no_project(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)

        linters = _detect_linters()

        assert linters == []

    def test_lint_runs(self, tmp_path, monkeypatch):
        (tmp_path / "pyproject.toml").write_text("[tool.ruff]")
        (tmp_path / "test.py").write_text("x = 1\n")
        monkeypatch.chdir(tmp_path)

        with patch("subprocess.run") as mock_run:
            mock_run.return_value.stdout = (
                '[{"filename": "test.py", "location": {"row": 1, "column": 1}, '
                '"message": "unused variable", "code": "F841"}]'
            )
            mock_run.return_value.returncode = 1
            result = lint()

        assert "diagnostics" in result
        assert result["diagnostics"][0]["file"] == "test.py"

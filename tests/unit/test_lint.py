from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

import pytest

from mycli.domain.runtime import ExecutionPolicy, PowerShellEdition, ShellKind, ShellProfile
from mycli.tools.lint import LintTool, _detect_linters, lint


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

    def test_builtin_linter_runs_as_direct_argv(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[tool.ruff]", encoding="utf-8")
        completed = subprocess.CompletedProcess([], 0, stdout="[]", stderr="")

        with patch("mycli.tools.lint.subprocess.run", return_value=completed) as run:
            lint(cwd=tmp_path)

        args, kwargs = run.call_args
        assert args[0] == ["ruff", "check", "--output-format", "json"]
        assert "shell" not in kwargs

    def test_configured_compound_linter_uses_active_shell_profile(self, tmp_path):
        (tmp_path / "custom.toml").write_text("", encoding="utf-8")
        profile = ShellProfile(
            ShellKind.POWERSHELL,
            Path("pwsh.exe"),
            PowerShellEdition.CORE,
        )
        completed = subprocess.CompletedProcess([], 0, stdout="", stderr="")

        with (
            patch.dict(
                "mycli.tools.lint.PROJECT_LINTERS",
                {"custom.toml": ["Invoke-Lint; Write-Output done"]},
                clear=True,
            ),
            patch("mycli.tools.lint.subprocess.run", return_value=completed) as run,
        ):
            lint(cwd=tmp_path, shell_profile=profile)

        assert run.call_args.args[0] == profile.exec_argv(
            "Invoke-Lint; Write-Output done"
        )

    def test_lint_tool_uses_configured_shell_profile(self):
        tool = LintTool()
        profile = ShellProfile(ShellKind.SH, Path("/bin/sh"))
        tool.configure_shell_profile(profile)

        with patch(
            "mycli.tools.lint.lint",
            return_value={"diagnostics": [], "count": 0, "truncated": False},
        ) as lint_call:
            tool.execute({})

        assert lint_call.call_args.kwargs["shell_profile"] == profile

    def test_lint_tool_model_output_preserves_diagnostic_fields(self):
        tool = LintTool()
        with patch(
            "mycli.tools.lint.lint",
            return_value={
                "diagnostics": [
                    {
                        "file": "src/app.py",
                        "line": 3,
                        "column": 4,
                        "rule": "F841",
                        "message": "local variable is assigned but never used",
                    }
                ],
                "count": 1,
                "truncated": False,
            },
        ):
            result = tool.execute({})

        assert result.model_output is not None
        assert result.model_output.text_content() == (
            "Lint diagnostics: 1\n"
            "src/app.py:3:4 [F841] local variable is assigned but never used"
        )

    @pytest.mark.skipif(sys.platform != "darwin", reason="requires macOS Seatbelt")
    def test_linter_process_cannot_write_outside_workspace(self, tmp_path):
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        (workspace / "custom.toml").write_text("", encoding="utf-8")
        outside = tmp_path / "outside.txt"
        script = workspace / "lint_probe.py"
        script.write_text(
            "\n".join(
                [
                    "from pathlib import Path",
                    "try:",
                    f"    Path({str(outside)!r}).write_text('escaped')",
                    "except OSError:",
                    "    pass",
                    "print('[]')",
                ]
            ),
            encoding="utf-8",
        )
        tool = LintTool(workspace)

        with patch.dict(
            "mycli.tools.lint.PROJECT_LINTERS",
            {"custom.toml": [(sys.executable, str(script))]},
            clear=True,
        ):
            result = tool.execute(
                {
                    "_runtime_sandbox_profile": ExecutionPolicy.for_workspace(
                        workspace
                    ).sandbox
                }
            )

        assert result.success is True
        assert not outside.exists()

from pathlib import Path

from mycli.domain.runtime import RiskLevel, ShellExecutionOptions
from mycli.domain.tools import ToolCall
from mycli.services.safety_policy import SafetyPolicy
from mycli.tools.bash import BashTool, derive_command_pattern, execute_bash


def test_shell_tool_executes_structured_args(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.run(
        ToolCall(
            name="Bash",
            arguments={"args": ["python3", "-c", "print('ok')"]},
            reason="check shell wiring",
        )
    )

    assert result.success is True
    assert result.raw_payload["output"].strip() == "ok"
    assert result.raw_payload["exit_code"] == 0
    assert result.raw_payload["stdout"].strip() == "ok"
    assert result.raw_payload["stderr"] == ""
    assert result.raw_payload["timed_out"] is False
    assert isinstance(result.raw_payload["duration_ms"], int)
    assert result.raw_payload["command_pattern"] == "python3 -c print('ok')"


def test_shell_tool_executes_with_workspace_cwd(tmp_path: Path) -> None:
    nested = tmp_path / "nested"
    nested.mkdir()
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "pwd", "cwd": "nested"})

    assert result.success is True
    assert result.raw_payload["cwd"] == str(nested.resolve())
    assert str(nested.resolve()) in result.raw_payload["output"]


def test_shell_tool_applies_runtime_enforcement_timeout_cap(
    monkeypatch,
    tmp_path: Path,
) -> None:
    tool = BashTool(workspace_root=tmp_path)
    seen: dict[str, object] = {}

    def fake_execute_bash(
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        env: dict[str, str] | None = None,
    ) -> dict[str, object]:
        seen.update(
            {
                "command": command,
                "timeout": timeout,
                "workdir": workdir,
                "run_in_background": run_in_background,
                "env": env,
            }
        )
        return {"exit_code": 0, "output": "ok", "truncated": False}

    monkeypatch.setattr("mycli.tools.bash.execute_bash", fake_execute_bash)

    result = tool.execute(
        {
            "command": "python3 -c 'print(1)'",
            "timeout": 999,
            "_runtime_shell_options": ShellExecutionOptions(
                workspace_root=tmp_path,
                max_timeout_seconds=5,
            ),
        }
    )

    assert result.success is True
    assert seen["timeout"] == 5
    assert result.raw_payload["runtime_enforcement"]["timeout_seconds"] == 5
    assert result.raw_payload["runtime_enforcement"]["timeout_capped"] is True
    assert result.raw_payload["runtime_enforcement"]["env_policy"] == "sanitized"


def test_shell_tool_applies_sanitized_runtime_environment(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("MYCLI_SECRET_SHOULD_NOT_LEAK", "secret-value")
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("PWD", "/outside-workspace")
    tool = BashTool(workspace_root=tmp_path)
    seen: dict[str, object] = {}

    def fake_execute_bash(
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        env: dict[str, str] | None = None,
    ) -> dict[str, object]:
        del command, timeout, workdir, run_in_background
        seen["env"] = dict(env or {})
        return {"exit_code": 0, "output": "ok", "truncated": False}

    monkeypatch.setattr("mycli.tools.bash.execute_bash", fake_execute_bash)

    result = tool.execute(
        {
            "command": "python3 -c 'print(1)'",
            "_runtime_shell_options": ShellExecutionOptions(workspace_root=tmp_path),
        }
    )

    env = seen["env"]
    assert isinstance(env, dict)
    assert env["PATH"] == "/usr/bin"
    assert env["PWD"] == str(tmp_path)
    assert "MYCLI_SECRET_SHOULD_NOT_LEAK" not in env
    assert result.raw_payload["runtime_enforcement"]["env_keys"] == sorted(env)
    assert "secret-value" not in str(result.raw_payload["runtime_enforcement"])


def test_shell_tool_rejects_cwd_outside_workspace(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "pwd", "cwd": "../outside"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "workspace_escape"


def test_execute_bash_reports_nonzero_exit() -> None:
    result = execute_bash(
        "python3 -c \"import sys; sys.stderr.write('bad'); sys.exit(7)\""
    )

    assert result["exit_code"] == 7
    assert result["error_kind"] == "nonzero_exit"
    assert result["stderr"] == "bad"
    assert "[stderr]" in result["output"]
    assert result["timed_out"] is False


def test_execute_bash_reports_timeout() -> None:
    result = execute_bash(
        "python3 -c \"import time; time.sleep(1)\"",
        timeout=0,
    )

    assert result["exit_code"] == 143
    assert result["error_kind"] == "timeout"
    assert result["timed_out"] is True
    assert result["timeout_seconds"] == 0


def test_execute_bash_reports_truncation_metadata() -> None:
    result = execute_bash("python3 -c \"print('x' * 20000)\"")

    assert result["truncated"] is True
    assert result["output_chars"] > 10_000
    assert result["stdout_chars"] > 10_000
    assert result["stdout_truncated"] is True
    assert result["stderr_truncated"] is False
    assert result["truncated_chars"] > 0


def test_shell_tool_returns_error_when_args_are_missing(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.run(
        ToolCall(
            name="Bash",
            arguments={},
            reason="broken tool call",
        )
    )

    assert result.success is False
    assert "command" in result.error


def test_shell_tool_returns_failure_when_command_is_missing(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.run(
        ToolCall(
            name="Bash",
            arguments={"args": ["command-that-does-not-exist-xyz", "--version"]},
            reason="check shell wiring",
        )
    )

    assert result.success is False
    assert result.error is not None
    assert "not found" in result.error or "No such file or directory" in result.error


def test_safety_policy_marks_shell_high_risk() -> None:
    risk = SafetyPolicy().classify(
        ToolCall(name="Bash", arguments={"command": "python3 -V"}, reason="inspect")
    )
    assert risk is RiskLevel.HIGH


def test_safety_policy_marks_file_editing_tools_medium_risk() -> None:
    policy = SafetyPolicy()

    assert policy.classify(
        ToolCall(name="Edit", arguments={"path": "README.md"}, reason="edit")
    ) is RiskLevel.MEDIUM
    assert policy.classify(
        ToolCall(
            name="Write",
            arguments={"path": "README.md", "content": "x"},
            reason="write",
        )
    ) is RiskLevel.MEDIUM


def test_derive_command_pattern_fallbacks_to_first_three_args() -> None:
    assert derive_command_pattern(["docker", "compose", "up", "-d"]) == "docker compose up"

def test_bash_tool_refuses_dedicated_read_command(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text("hello\n", encoding="utf-8")
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "cat README.md"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "dedicated_tool_required"
    assert result.raw_payload["reroute_tool"] == "Read"
    assert "Use Read instead" in result.error


def test_bash_tool_reroute_includes_actionable_read_arguments(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "head -100 data.csv"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "dedicated_tool_required"
    assert result.raw_payload["reroute_tool"] == "Read"
    assert result.raw_payload["suggested_arguments"] == {
        "file_path": "data.csv",
        "offset": 1,
        "limit": 100,
    }
    assert "file_path=data.csv" in result.error
    assert "limit=100" in result.error


def test_bash_tool_refuses_denied_command(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "rm -rf /"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "shell_command_denied"
    assert result.error == "rm -rf / is forbidden"


def test_bash_tool_does_not_reroute_confirm_level_command(monkeypatch, tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    def fake_execute_bash(
        command: str,
        timeout: int = 120,
        workdir: str | None = None,
        run_in_background: bool = False,
        env: dict[str, str] | None = None,
    ) -> dict[str, object]:
        del env
        return {"exit_code": 7, "output": "simulated", "truncated": False}

    monkeypatch.setattr("mycli.tools.bash.execute_bash", fake_execute_bash)

    result = tool.execute({"command": "cat README.md && echo done"})

    assert result.raw_payload.get("error_kind") != "dedicated_tool_required"
    assert result.error == "simulated"

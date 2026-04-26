from pathlib import Path

from mycli.domain.runtime import RiskLevel
from mycli.domain.tools import ToolCall
from mycli.services.safety_policy import SafetyPolicy
from mycli.tools.run_shell import RunShellTool, derive_command_pattern


def test_shell_tool_executes_structured_args(tmp_path: Path) -> None:
    tool = RunShellTool(workspace_root=tmp_path)

    result = tool.run(
        ToolCall(
            name="run_shell",
            arguments={"args": ["python3", "-c", "print('ok')"]},
            reason="check shell wiring",
        )
    )

    assert result.success is True
    assert result.raw_payload["stdout"].strip() == "ok"


def test_shell_tool_returns_error_when_args_are_missing(tmp_path: Path) -> None:
    tool = RunShellTool(workspace_root=tmp_path)

    result = tool.run(
        ToolCall(
            name="run_shell",
            arguments={},
            reason="broken tool call",
        )
    )

    assert result.success is False
    assert "args" in result.error


def test_shell_tool_returns_failure_when_command_is_missing(tmp_path: Path) -> None:
    tool = RunShellTool(workspace_root=tmp_path)

    result = tool.run(
        ToolCall(
            name="run_shell",
            arguments={"args": ["command-that-does-not-exist-xyz", "--version"]},
            reason="check shell wiring",
        )
    )

    assert result.success is False
    assert result.error is not None
    assert "No such file or directory" in result.error


def test_safety_policy_marks_shell_high_risk() -> None:
    risk = SafetyPolicy().classify(
        ToolCall(name="run_shell", arguments={"args": ["python3", "-V"]}, reason="inspect")
    )
    assert risk is RiskLevel.HIGH


def test_safety_policy_marks_file_editing_tools_medium_risk() -> None:
    policy = SafetyPolicy()

    assert policy.classify(
        ToolCall(name="append_file", arguments={"path": "README.md", "content": "x"}, reason="append")
    ) is RiskLevel.MEDIUM
    assert policy.classify(
        ToolCall(
            name="replace_in_file",
            arguments={"path": "README.md", "old_text": "a", "new_text": "b"},
            reason="replace",
        )
    ) is RiskLevel.MEDIUM


def test_derive_command_pattern_fallbacks_to_first_three_args() -> None:
    assert derive_command_pattern(["docker", "compose", "up", "-d"]) == "docker compose up"

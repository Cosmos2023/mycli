from pathlib import Path

from mycli.domain.runtime import RiskLevel
from mycli.domain.tools import ToolCall
from mycli.services.safety_policy import SafetyPolicy
from mycli.tools.bash import BashTool, derive_command_pattern


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


def test_bash_tool_refuses_denied_command(tmp_path: Path) -> None:
    tool = BashTool(workspace_root=tmp_path)

    result = tool.execute({"command": "rm -rf /"})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "shell_command_denied"
    assert result.error == "rm -rf / is forbidden"
from pathlib import Path

from mycli.tools.bash import BashTool

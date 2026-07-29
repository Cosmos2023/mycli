from pathlib import Path

from mycli.tools.bash import BashTool, ShellTool, execute_bash
from tests.support.shell_commands import python_shell_command


def test_shell_exposes_optional_persistent_prefix_but_legacy_bash_does_not(
    tmp_path: Path,
) -> None:
    shell_parameters = {
        parameter.name: parameter for parameter in ShellTool(tmp_path).spec.parameters
    }
    bash_parameters = {
        parameter.name: parameter for parameter in BashTool(tmp_path).spec.parameters
    }

    assert shell_parameters["prefix_rule"].required is False
    assert shell_parameters["prefix_rule"].type == "array"
    assert shell_parameters["prefix_rule"].items_schema == {"type": "string"}
    assert "prefix_rule" not in bash_parameters


class TestBashExecution:
    def test_simple_execution(self):
        result = execute_bash("echo hello")

        assert result["exit_code"] == 0
        assert "hello" in result["output"]

    def test_output_below_session_limit_is_retained(self):
        result = execute_bash(python_shell_command("print('x' * 20000)"))

        assert result["truncated"] is False
        assert "[... chars omitted]" not in result["output"]

    def test_stderr_captured(self):
        result = execute_bash("echo error >&2")

        assert "[stderr]" in result["output"]
        assert "error" in result["output"]

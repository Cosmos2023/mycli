from __future__ import annotations

from mycli.tools.bash import ShellCommandRuntime
from mycli.tools.kill_shell import kill_shell


def test_shell_command_runtime_runs_foreground_command() -> None:
    runtime = ShellCommandRuntime()

    result = runtime.execute("printf hello")

    assert result["exit_code"] == 0
    assert result["stdout"] == "hello"
    assert result["process_state"] == "completed"


def test_shell_command_runtime_starts_background_command() -> None:
    runtime = ShellCommandRuntime()

    result = runtime.execute("sleep 5", run_in_background=True)
    shell_id = str(result["shell_id"])

    try:
        assert result["status"] == "running"
        assert result["process_state"] == "running_background"
        assert result["task_id"] == f"shell:{shell_id}"
    finally:
        kill_shell(shell_id)

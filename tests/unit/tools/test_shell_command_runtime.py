from __future__ import annotations

from mycli.tools.bash import ShellCommandRuntime
from mycli.tools.invocation_context import ToolInvocationContext, tool_invocation_scope
from mycli.tools.kill_shell import kill_shell
from mycli.tools.shell_registry import SHELL_REGISTRY, ShellProcessRegistry
from mycli.tools.shell_session_manager import ShellSessionManager
from tests.support.shell_transports import FakeShellTransport


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


def test_shell_command_runtime_uses_invocation_owner() -> None:
    runtime = ShellCommandRuntime(owner_session_id="main-session")

    with tool_invocation_scope(ToolInvocationContext("child-session")):
        result = runtime.execute("sleep 5", run_in_background=True)
    shell_id = str(result["shell_id"])

    try:
        denied = SHELL_REGISTRY.read(shell_id, owner_session_id="main-session")
        allowed = SHELL_REGISTRY.read(shell_id, owner_session_id="child-session")

        assert denied["error_kind"] == "shell_session_forbidden"
        assert "error" not in allowed
    finally:
        kill_shell(shell_id, session_id="child-session")


def test_registry_execute_new_uses_yield_contract(tmp_path) -> None:
    transport = FakeShellTransport(tty=True)
    manager = ShellSessionManager(transport_factory=lambda _request: transport)
    registry = ShellProcessRegistry(manager)

    result = registry.execute_new(
        "ignored",
        workdir=str(tmp_path),
        tty=True,
        yield_time_ms=25,
        max_output_tokens=123,
    )

    assert result["background"] is True
    assert result["yielded"] is True
    assert result["tty"] is True
    assert result["max_output_tokens"] == 123
    assert isinstance(result["wall_time_seconds"], float)
    assert result["wall_time_seconds"] >= 0
    transport.finish(0)

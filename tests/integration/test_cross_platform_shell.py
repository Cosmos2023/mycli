from __future__ import annotations

import threading
import time
from uuid import uuid4

from mycli.domain.runtime import RuntimeInterruptToken
from mycli.tools.base import ToolResult
from mycli.tools.bash import execute_bash
from mycli.tools.bash_output import BashOutputTool
from mycli.tools.kill_shell import KillShellTool


def _session_id() -> str:
    return f"cross-platform-{uuid4()}"


def _wait_for_terminal(
    shell_id: str,
    *,
    session_id: str,
    timeout_seconds: float = 5.0,
) -> ToolResult:
    deadline = time.monotonic() + timeout_seconds
    output_tool = BashOutputTool(session_id=session_id)
    while time.monotonic() < deadline:
        result = output_tool.execute({"shell_id": shell_id})
        if result.raw_payload.get("status") != "running":
            return result
        time.sleep(0.02)
    raise AssertionError(f"shell {shell_id} did not finish")


def test_foreground_shell_reports_output() -> None:
    result = execute_bash("printf cross-platform", owner_session_id=_session_id())

    assert result["exit_code"] == 0
    assert result["output"] == "cross-platform"
    assert result["process_state"] == "completed"


def test_foreground_shell_reports_nonzero_exit() -> None:
    result = execute_bash("exit 7", owner_session_id=_session_id())

    assert result["exit_code"] == 7
    assert result["error_kind"] == "nonzero_exit"
    assert result["process_state"] == "failed"


def test_background_shell_can_be_polled_to_completion() -> None:
    session_id = _session_id()
    started = execute_bash(
        "printf start; sleep 0.2; printf end",
        owner_session_id=session_id,
        run_in_background=True,
    )
    shell_id = str(started["shell_id"])

    result = _wait_for_terminal(shell_id, session_id=session_id)

    assert result.success is True
    assert result.raw_payload["status"] == "exited"
    assert result.raw_payload["output"] == "startend"
    assert result.raw_payload["process_state"] == "completed"


def test_foreground_shell_timeout_terminates_process() -> None:
    result = execute_bash("sleep 2", timeout=1, owner_session_id=_session_id())

    assert result["exit_code"] == 143
    assert result["error_kind"] == "timeout"
    assert result["terminal_state"] == "timed_out"
    assert result["process_state"] == "timed_out"


def test_foreground_shell_interrupt_terminates_process() -> None:
    token = RuntimeInterruptToken(source="cross-platform-smoke")
    result_holder: dict[str, dict[str, object]] = {}
    started = threading.Event()

    def run_command() -> None:
        started.set()
        result_holder["result"] = execute_bash(
            "sleep 30",
            timeout=30,
            owner_session_id=_session_id(),
            interrupt_token=token,
        )

    thread = threading.Thread(target=run_command)
    thread.start()
    assert started.wait(timeout=1.0)
    time.sleep(0.1)
    token.request("test_interrupt")
    thread.join(timeout=5.0)

    assert not thread.is_alive()
    result = result_holder["result"]
    assert result["exit_code"] == 130
    assert result["error_kind"] == "interrupted"
    assert result["terminal_state"] == "interrupted"
    assert result["process_state"] == "interrupted"


def test_kill_shell_terminates_background_process() -> None:
    session_id = _session_id()
    started = execute_bash(
        "sleep 30",
        owner_session_id=session_id,
        run_in_background=True,
    )
    shell_id = str(started["shell_id"])

    result = KillShellTool(session_id=session_id).execute({"shell_id": shell_id})

    assert result.success is True
    assert result.raw_payload["status"] == "killed"
    assert result.raw_payload["process_state"] == "killed"
    assert result.raw_payload["cleanup_result"] in {"terminated", "killed_after_timeout"}

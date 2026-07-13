from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import sys
import threading
import time
from uuid import uuid4

import pytest

from mycli.domain.runtime import (
    PowerShellEdition,
    RuntimeInterruptToken,
    ShellKind,
    ShellProfile,
)
from mycli.tools.base import ToolResult
from mycli.tools.bash import execute_bash
from mycli.tools.kill_shell import KillShellTool
from mycli.tools.shell_output import ShellOutputTool
from mycli.tools.shell_resolver import detect_shell_profile


@dataclass(frozen=True, slots=True)
class ShellSmokeCommands:
    output: str
    nonzero: str
    background: str
    sleep: str


@dataclass(frozen=True, slots=True)
class ShellSmokeCase:
    profile: ShellProfile
    commands: ShellSmokeCommands


POSIX = ShellSmokeCommands(
    output="printf cross-platform",
    nonzero="exit 7",
    background="printf start; sleep 0.2; printf end",
    sleep="sleep 30",
)
POWERSHELL = ShellSmokeCommands(
    output="[Console]::Write('cross-platform')",
    nonzero="exit 7",
    background=(
        "[Console]::Write('start'); Start-Sleep -Milliseconds 200; "
        "[Console]::Write('end')"
    ),
    sleep="Start-Sleep -Seconds 30",
)
CMD = ShellSmokeCommands(
    output="<nul set /p =cross-platform",
    nonzero="exit /b 7",
    background="<nul set /p =start & ping -n 2 127.0.0.1 >nul & <nul set /p =end",
    sleep="ping -n 31 127.0.0.1 >nul",
)


@pytest.fixture(params=("posix", "pwsh", "powershell", "cmd"))
def shell_case(request: pytest.FixtureRequest) -> ShellSmokeCase:
    mode = str(request.param)
    requested_mode = os.environ.get("MYCLI_TEST_SHELL_MODE")
    if sys.platform == "win32":
        if requested_mode and mode != requested_mode:
            pytest.skip(f"Windows CI lane requested {requested_mode}")
        if mode == "posix":
            pytest.skip("POSIX shell smoke runs on macOS and Linux")
    elif mode != "posix":
        pytest.skip(f"{mode} shell smoke requires Windows")

    if mode == "posix":
        profile = detect_shell_profile(None)
        if profile.kind not in {ShellKind.ZSH, ShellKind.BASH, ShellKind.SH}:
            pytest.skip("no POSIX shell profile is available")
        return ShellSmokeCase(profile, POSIX)
    if mode == "pwsh":
        executable = shutil.which("pwsh.exe") or shutil.which("pwsh")
        if executable is None:
            pytest.skip("PowerShell 7 executable is unavailable")
        return ShellSmokeCase(
            ShellProfile(
                ShellKind.POWERSHELL,
                Path(executable),
                PowerShellEdition.CORE,
            ),
            POWERSHELL,
        )
    if mode == "powershell":
        executable = shutil.which("powershell.exe") or shutil.which("powershell")
        if executable is None:
            pytest.skip("Windows PowerShell 5.1 executable is unavailable")
        return ShellSmokeCase(
            ShellProfile(
                ShellKind.POWERSHELL,
                Path(executable),
                PowerShellEdition.DESKTOP,
            ),
            POWERSHELL,
        )
    executable = os.environ.get("COMSPEC") or shutil.which("cmd.exe")
    if executable is None:
        pytest.skip("cmd.exe is unavailable")
    return ShellSmokeCase(ShellProfile(ShellKind.CMD, Path(executable)), CMD)


def _session_id() -> str:
    return f"cross-platform-{uuid4()}"


def _wait_for_terminal(
    shell_id: str,
    *,
    session_id: str,
    timeout_seconds: float = 8.0,
) -> ToolResult:
    deadline = time.monotonic() + timeout_seconds
    output_tool = ShellOutputTool(session_id=session_id)
    while time.monotonic() < deadline:
        result = output_tool.execute({"shell_id": shell_id})
        if result.raw_payload.get("status") != "running":
            return result
        time.sleep(0.02)
    raise AssertionError(f"shell {shell_id} did not finish")


def test_foreground_shell_reports_output(shell_case: ShellSmokeCase) -> None:
    result = execute_bash(
        shell_case.commands.output,
        owner_session_id=_session_id(),
        shell_profile=shell_case.profile,
    )

    assert result["exit_code"] == 0
    assert result["output"] == "cross-platform"
    assert result["process_state"] == "completed"
    assert result["shell_kind"] == shell_case.profile.kind.value


def test_foreground_shell_reports_nonzero_exit(shell_case: ShellSmokeCase) -> None:
    result = execute_bash(
        shell_case.commands.nonzero,
        owner_session_id=_session_id(),
        shell_profile=shell_case.profile,
    )

    assert result["exit_code"] == 7
    assert result["error_kind"] == "nonzero_exit"
    assert result["process_state"] == "failed"


def test_background_shell_can_be_polled_to_completion(shell_case: ShellSmokeCase) -> None:
    session_id = _session_id()
    started = execute_bash(
        shell_case.commands.background,
        owner_session_id=session_id,
        run_in_background=True,
        shell_profile=shell_case.profile,
    )
    shell_id = str(started["shell_id"])

    result = _wait_for_terminal(shell_id, session_id=session_id)

    assert result.success is True
    assert result.raw_payload["status"] == "exited"
    assert result.raw_payload["output"] == "startend"
    assert result.raw_payload["process_state"] == "completed"


def test_foreground_shell_timeout_terminates_process(shell_case: ShellSmokeCase) -> None:
    result = execute_bash(
        shell_case.commands.sleep,
        timeout=1,
        owner_session_id=_session_id(),
        shell_profile=shell_case.profile,
    )

    assert result["exit_code"] == 143
    assert result["error_kind"] == "timeout"
    assert result["terminal_state"] == "timed_out"
    assert result["process_state"] == "timed_out"


def test_foreground_shell_interrupt_terminates_process(shell_case: ShellSmokeCase) -> None:
    token = RuntimeInterruptToken(source="cross-platform-smoke")
    result_holder: dict[str, dict[str, object]] = {}
    started = threading.Event()

    def run_command() -> None:
        started.set()
        result_holder["result"] = execute_bash(
            shell_case.commands.sleep,
            timeout=30,
            owner_session_id=_session_id(),
            shell_profile=shell_case.profile,
            interrupt_token=token,
        )

    thread = threading.Thread(target=run_command)
    thread.start()
    assert started.wait(timeout=1.0)
    time.sleep(0.1)
    token.request("test_interrupt")
    thread.join(timeout=8.0)

    assert not thread.is_alive()
    result = result_holder["result"]
    assert result["exit_code"] == 130
    assert result["error_kind"] == "interrupted"
    assert result["terminal_state"] == "interrupted"
    assert result["process_state"] == "interrupted"


def test_kill_shell_terminates_background_process(shell_case: ShellSmokeCase) -> None:
    session_id = _session_id()
    started = execute_bash(
        shell_case.commands.sleep,
        owner_session_id=session_id,
        run_in_background=True,
        shell_profile=shell_case.profile,
    )
    shell_id = str(started["shell_id"])

    result = KillShellTool(session_id=session_id).execute({"shell_id": shell_id})

    assert result.success is True
    assert result.raw_payload["status"] == "killed"
    assert result.raw_payload["process_state"] == "killed"
    assert result.raw_payload["cleanup_result"] in {
        "terminated",
        "killed_after_timeout",
        "sent_ctrl_break",
        "taskkill_tree",
    }

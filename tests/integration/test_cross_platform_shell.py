from __future__ import annotations

from dataclasses import dataclass, replace
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
    ShellLifecycleEvent,
    ShellProfile,
)
from mycli.tools.base import ToolResult
from mycli.tools.bash import ShellTool, execute_bash
from mycli.tools.kill_shell import KillShellTool
from mycli.tools.shell_output import ShellOutputTool
from mycli.tools.shell_resolver import detect_shell_profile
from mycli.tools.write_stdin import WriteStdinTool


@dataclass(frozen=True, slots=True)
class ShellSmokeCommands:
    output: str
    nonzero: str
    background: str
    sleep: str
    partial_then_sleep: str
    prompt: str
    input_text: str
    expected_response: str


@dataclass(frozen=True, slots=True)
class ShellSmokeCase:
    profile: ShellProfile
    commands: ShellSmokeCommands


POSIX = ShellSmokeCommands(
    output="printf cross-platform",
    nonzero="exit 7",
    background="printf start; sleep 0.2; printf end",
    sleep="sleep 30",
    partial_then_sleep="printf ready; sleep 0.6; printf done",
    prompt="printf 'Name: '; IFS= read -r value; printf 'hello:%s\\n' \"$value\"",
    input_text="codex\n",
    expected_response="hello:codex",
)
POWERSHELL = ShellSmokeCommands(
    output="[Console]::Write('cross-platform')",
    nonzero="exit 7",
    background=(
        "[Console]::Write('start'); Start-Sleep -Milliseconds 200; "
        "[Console]::Write('end')"
    ),
    sleep="Start-Sleep -Seconds 30",
    partial_then_sleep=(
        "[Console]::Write('ready'); Start-Sleep -Milliseconds 600; "
        "[Console]::Write('done')"
    ),
    prompt=(
        "[Console]::Write('Name: '); $value = [Console]::ReadLine(); "
        "[Console]::Write(\"hello:$value\")"
    ),
    input_text="codex\r\n",
    expected_response="hello:codex",
)
CMD = ShellSmokeCommands(
    output="<nul set /p =cross-platform",
    nonzero="exit /b 7",
    background="<nul set /p =start & ping -n 2 127.0.0.1 >nul & <nul set /p =end",
    sleep="ping -n 31 127.0.0.1 >nul",
    partial_then_sleep=(
        "<nul set /p =ready & ping -n 2 127.0.0.1 >nul & <nul set /p =done"
    ),
    prompt=(
        "setlocal EnableDelayedExpansion & set /p value=Name:  & echo hello:!value!"
    ),
    input_text="codex\r\n",
    expected_response="hello:codex",
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
    output_parts: list[str] = []
    while time.monotonic() < deadline:
        result = output_tool.execute({"shell_id": shell_id})
        output = result.raw_payload.get("output")
        if isinstance(output, str) and output:
            output_parts.append(output)
        if result.raw_payload.get("status") != "running":
            return replace(
                result,
                raw_payload={
                    **result.raw_payload,
                    "output": "".join(output_parts),
                },
            )
        time.sleep(0.02)
    raise AssertionError(f"shell {shell_id} did not finish")


def _shell_tool(
    tmp_path: Path,
    shell_case: ShellSmokeCase,
    *,
    session_id: str,
) -> ShellTool:
    tool = ShellTool(tmp_path)
    tool.configure_shell_session(session_id)
    tool.configure_shell_profile(shell_case.profile)
    return tool


def _write_stdin_until_terminal(
    writer: WriteStdinTool,
    shell_id: str,
    *,
    chars: str = "",
    timeout_seconds: float = 8.0,
) -> ToolResult:
    deadline = time.monotonic() + timeout_seconds
    output_parts: list[str] = []
    pending_chars = chars
    while time.monotonic() < deadline:
        result = writer.execute(
            {
                "session_id": shell_id,
                "chars": pending_chars,
                "yield_time_ms": 2000,
            }
        )
        pending_chars = ""
        assert result.success is True
        output = result.raw_payload.get("output")
        if isinstance(output, str) and output:
            output_parts.append(output)
        if result.raw_payload.get("terminal_state") is not None:
            return replace(
                result,
                raw_payload={
                    **result.raw_payload,
                    "output": "".join(output_parts),
                },
            )
    raise AssertionError(f"shell {shell_id} did not finish through WriteStdin")


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


def test_pipe_streams_partial_output_before_newline(
    shell_case: ShellSmokeCase,
    tmp_path: Path,
) -> None:
    session_id = _session_id()
    events: list[ShellLifecycleEvent] = []
    tool = _shell_tool(tmp_path, shell_case, session_id=session_id)
    tool.configure_shell_lifecycle(events.append)

    result = tool.execute(
        {
            "command": shell_case.commands.partial_then_sleep,
            "yield_time_ms": 250,
            "tty": False,
        }
    )
    shell_id = str(result.raw_payload["shell_id"])

    try:
        assert result.raw_payload["process_state"] == "running_background"
        assert result.raw_payload["yielded"] is True
        assert result.raw_payload["transport"] == "pipe"
        assert result.raw_payload["tty"] is False
        assert "ready" in str(result.raw_payload["output"])
        assert any(
            event.kind == "shell.output" and "ready" in event.output_delta
            for event in events
        )
    finally:
        KillShellTool(session_id=session_id).execute({"shell_id": shell_id})


def test_write_stdin_waits_for_yielded_shell_completion(
    shell_case: ShellSmokeCase,
    tmp_path: Path,
) -> None:
    session_id = _session_id()
    shell = _shell_tool(tmp_path, shell_case, session_id=session_id)
    started = shell.execute(
        {
            "command": shell_case.commands.partial_then_sleep,
            "yield_time_ms": 250,
            "tty": False,
        }
    )
    shell_id = str(started.raw_payload["shell_id"])

    try:
        result = _write_stdin_until_terminal(
            WriteStdinTool(session_id=session_id),
            shell_id,
        )

        assert result.success is True
        assert result.raw_payload["shell_id"] == shell_id
        assert result.raw_payload["terminal_state"] == "completed"
        assert "done" in str(result.raw_payload["output"])
    finally:
        KillShellTool(session_id=session_id).execute({"shell_id": shell_id})


def test_native_terminal_round_trip(
    shell_case: ShellSmokeCase,
    tmp_path: Path,
) -> None:
    session_id = _session_id()
    shell = _shell_tool(tmp_path, shell_case, session_id=session_id)
    started = shell.execute(
        {
            "command": shell_case.commands.prompt,
            "yield_time_ms": 250,
            "tty": True,
        }
    )
    shell_id = str(started.raw_payload["shell_id"])

    try:
        result = _write_stdin_until_terminal(
            WriteStdinTool(session_id=session_id),
            shell_id,
            chars=shell_case.commands.input_text,
        )

        assert result.success is True
        assert result.raw_payload["tty"] is True
        assert result.raw_payload["transport"] == (
            "windows_conpty" if sys.platform == "win32" else "unix_pty"
        )
        assert result.raw_payload["terminal_state"] == "completed"
        assert shell_case.commands.expected_response in str(
            result.raw_payload["output"]
        )
    finally:
        KillShellTool(session_id=session_id).execute({"shell_id": shell_id})

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import os
import signal
import subprocess
import sys
from typing import Protocol


WINDOWS_CREATE_NEW_PROCESS_GROUP = getattr(
    subprocess,
    "CREATE_NEW_PROCESS_GROUP",
    0x00000200,
)
WINDOWS_CTRL_BREAK_EVENT = getattr(signal, "CTRL_BREAK_EVENT", 1)
CANCELLATION_TERMINATION_GRACE_SECONDS = 0.05


class ManagedProcess(Protocol):
    pid: int

    def poll(self) -> int | None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def send_signal(self, value: int) -> None: ...

    def terminate(self) -> None: ...


@dataclass(frozen=True, slots=True)
class ProcessTerminationOutcome:
    cleanup_result: str
    terminal: bool
    error: str | None = None


WaitForExit = Callable[[ManagedProcess, float], bool]
KillProcessGroup = Callable[[int, int], None]
Taskkill = Callable[[list[str]], None]


def process_spawn_options(*, platform_name: str = sys.platform) -> dict[str, object]:
    if platform_name == "win32":
        return {"creationflags": WINDOWS_CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def terminate_process_tree(
    process: ManagedProcess,
    *,
    prefer_interrupt: bool,
    platform_name: str = sys.platform,
    killpg: KillProcessGroup = os.killpg,
    wait_for_exit: WaitForExit | None = None,
    taskkill: Taskkill | None = None,
) -> ProcessTerminationOutcome:
    if process.poll() is not None:
        return ProcessTerminationOutcome("already_exited", terminal=True)
    waiter = wait_for_exit or _wait_for_exit
    if platform_name == "win32":
        return _terminate_windows(
            process,
            prefer_interrupt=prefer_interrupt,
            wait_for_exit=waiter,
            taskkill=taskkill or _run_taskkill,
        )
    return _terminate_unix(
        process,
        prefer_interrupt=prefer_interrupt,
        killpg=killpg,
        wait_for_exit=waiter,
    )


def _terminate_unix(
    process: ManagedProcess,
    *,
    prefer_interrupt: bool,
    killpg: KillProcessGroup,
    wait_for_exit: WaitForExit,
) -> ProcessTerminationOutcome:
    stages: tuple[tuple[int, str, float], ...] = (
        (signal.SIGINT, "sent_sigint", 0.5),
        (
            signal.SIGTERM,
            "sent_sigterm",
            CANCELLATION_TERMINATION_GRACE_SECONDS,
        ),
        (signal.SIGKILL, "sent_sigkill", 0.5),
    )
    if not prefer_interrupt:
        stages = stages[1:]
    last_result = "already_exited"
    last_error: str | None = None
    for sig, label, timeout in stages:
        if process.poll() is not None:
            return ProcessTerminationOutcome(last_result, terminal=True, error=last_error)
        try:
            killpg(process.pid, sig)
            last_result = label
            last_error = None
        except ProcessLookupError:
            return ProcessTerminationOutcome(last_result, terminal=True, error=last_error)
        except (OSError, PermissionError) as exc:
            last_result = f"{label}_failed"
            last_error = str(exc)
            continue
        if wait_for_exit(process, timeout) or process.poll() is not None:
            return ProcessTerminationOutcome(last_result, terminal=True)
    return ProcessTerminationOutcome(last_result, terminal=False, error=last_error)


def _terminate_windows(
    process: ManagedProcess,
    *,
    prefer_interrupt: bool,
    wait_for_exit: WaitForExit,
    taskkill: Taskkill,
) -> ProcessTerminationOutcome:
    if prefer_interrupt:
        try:
            process.send_signal(WINDOWS_CTRL_BREAK_EVENT)
        except OSError as exc:
            interrupt_error: str | None = str(exc)
        else:
            interrupt_error = None
            if wait_for_exit(process, 0.5) or process.poll() is not None:
                return ProcessTerminationOutcome("sent_ctrl_break", terminal=True)
    else:
        interrupt_error = None

    try:
        process.terminate()
    except OSError as exc:
        terminate_error: str | None = str(exc)
    else:
        terminate_error = None
        if (
            wait_for_exit(process, CANCELLATION_TERMINATION_GRACE_SECONDS)
            or process.poll() is not None
        ):
            return ProcessTerminationOutcome("terminated", terminal=True)

    try:
        taskkill(["taskkill", "/PID", str(process.pid), "/T", "/F"])
    except OSError as exc:
        return ProcessTerminationOutcome(
            "taskkill_failed",
            terminal=process.poll() is not None,
            error=str(exc),
        )
    terminal = process.poll() is not None
    error = None if terminal else terminate_error or interrupt_error or "process still running"
    return ProcessTerminationOutcome("taskkill_tree", terminal=terminal, error=error)


def _wait_for_exit(process: ManagedProcess, timeout: float) -> bool:
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        return False
    except (OSError, PermissionError):
        return process.poll() is not None
    return True


def _run_taskkill(command: list[str]) -> None:
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "taskkill failed"
        raise OSError(detail)

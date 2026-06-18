from __future__ import annotations

from collections.abc import Callable
import contextlib
from dataclasses import dataclass, field
from datetime import UTC, datetime
import hashlib
import os
from pathlib import Path
import subprocess
import threading
import time
from uuid import uuid4

from mycli.domain.runtime.background_jobs import BackgroundJobState, BackgroundJobSummary
from mycli.domain.runtime.task_notifications import TaskNotification


@dataclass(slots=True)
class ShellProcess:
    shell_id: str
    command: str
    command_hash: str
    command_length: int
    command_pattern: str | None
    process: subprocess.Popen[str]
    started_at: str
    cwd: str
    timeout_seconds: int | None = None
    last_observed_at: str | None = None
    terminal_state: str | None = None
    cleanup_result: str | None = None
    output_file: Path | None = None
    notification_sink: Callable[[TaskNotification], None] | None = None
    notified: bool = False
    output: list[str] = field(default_factory=list)
    read_offset: int = 0


_TERMINAL_STATES = frozenset({"completed", "failed", "timed_out", "interrupted", "killed"})


class ShellProcessRegistry:
    def __init__(self) -> None:
        self._processes: dict[str, ShellProcess] = {}
        self._lock = threading.Lock()

    def start(
        self,
        command: str,
        *,
        workdir: str | None = None,
        env: dict[str, str] | None = None,
        timeout_seconds: int | None = None,
        command_pattern: str | None = None,
        output_file: Path | None = None,
        notification_sink: Callable[[TaskNotification], None] | None = None,
    ) -> ShellProcess:
        cwd = workdir or os.getcwd()
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=cwd,
            executable=os.environ.get("SHELL", "/bin/bash"),
            env=env,
        )
        now = _now_iso()
        shell = ShellProcess(
            shell_id=uuid4().hex[:8],
            command=command,
            command_hash=_hash_command(command),
            command_length=len(command),
            command_pattern=command_pattern,
            process=process,
            started_at=now,
            cwd=cwd,
            timeout_seconds=timeout_seconds,
            last_observed_at=now,
            output_file=output_file,
            notification_sink=notification_sink,
        )
        if output_file is not None:
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_text("", encoding="utf-8")
        with self._lock:
            self._processes[shell.shell_id] = shell
        threading.Thread(target=self._drain_output, args=(shell,), daemon=True).start()
        return shell

    def read(self, shell_id: str) -> dict[str, object]:
        self._wait_for_initial_output(shell_id)
        with self._lock:
            shell = self._processes.get(shell_id)
            if shell is None:
                return {
                    "error_kind": "shell_not_found",
                    "error": f"No such shell: {shell_id}",
                }
            output = "".join(shell.output[shell.read_offset :])
            shell.read_offset = len(shell.output)
            exit_code = self._observe_locked(shell)
            return {
                "shell_id": shell.shell_id,
                "status": _status_for_exit_code(exit_code, shell.terminal_state),
                "process_state": _process_state_for_exit_code(exit_code, shell.terminal_state),
                "exit_code": exit_code,
                "output": output,
                "output_chars": sum(len(part) for part in shell.output),
                "new_output_chars": len(output),
                "started_at": shell.started_at,
                "last_observed_at": shell.last_observed_at,
                "cwd": shell.cwd,
                "timeout_seconds": shell.timeout_seconds,
                "command_hash": shell.command_hash,
                "command_length": shell.command_length,
                "command_pattern": shell.command_pattern,
                "terminal_state": shell.terminal_state,
                "cleanup_result": shell.cleanup_result,
                "output_file": str(shell.output_file) if shell.output_file else None,
            }

    def _wait_for_initial_output(self, shell_id: str) -> None:
        deadline = time.monotonic() + 0.25
        while time.monotonic() < deadline:
            with self._lock:
                shell = self._processes.get(shell_id)
                if shell is None:
                    return
                if shell.output or shell.process.poll() is not None:
                    return
            time.sleep(0.01)

    def list(self) -> list[dict[str, object]]:
        with self._lock:
            for shell in self._processes.values():
                self._observe_locked(shell)
            return [
                {
                    "shell_id": shell.shell_id,
                    "status": _status_for_exit_code(shell.process.poll(), shell.terminal_state),
                    "process_state": _process_state_for_exit_code(
                        shell.process.poll(),
                        shell.terminal_state,
                    ),
                    "exit_code": shell.process.poll(),
                    "started_at": shell.started_at,
                    "last_observed_at": shell.last_observed_at,
                    "cwd": shell.cwd,
                    "timeout_seconds": shell.timeout_seconds,
                    "command_hash": shell.command_hash,
                    "command_length": shell.command_length,
                    "command_pattern": shell.command_pattern,
                    "output_chars": sum(len(part) for part in shell.output),
                    "terminal_state": shell.terminal_state,
                    "cleanup_result": shell.cleanup_result,
                    "output_file": str(shell.output_file) if shell.output_file else None,
                }
                for shell in self._processes.values()
            ]

    def kill(self, shell_id: str) -> dict[str, object]:
        with self._lock:
            shell = self._processes.get(shell_id)
        if shell is None:
            return {
                "error_kind": "shell_not_found",
                "error": f"No such shell: {shell_id}",
            }
        cleanup_result = "already_exited"
        if shell.process.poll() is None:
            cleanup_result = "terminated"
            shell.process.terminate()
            try:
                shell.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                cleanup_result = "killed_after_timeout"
                shell.process.kill()
                shell.process.wait()
        with self._lock:
            shell.terminal_state = "killed"
            shell.cleanup_result = cleanup_result
            shell.last_observed_at = _now_iso()
            notification = self._notification_for_locked(shell)
        if notification is not None and shell.notification_sink is not None:
            with contextlib.suppress(Exception):
                shell.notification_sink(notification)
        return {
            "status": "killed",
            "exit_code": shell.process.returncode,
            "shell_id": shell_id,
            "process_state": "killed",
            "started_at": shell.started_at,
            "last_observed_at": shell.last_observed_at,
            "cwd": shell.cwd,
            "timeout_seconds": shell.timeout_seconds,
            "command_hash": shell.command_hash,
            "command_length": shell.command_length,
            "command_pattern": shell.command_pattern,
            "output_chars": sum(len(part) for part in shell.output),
            "terminal_state": shell.terminal_state,
            "cleanup_result": cleanup_result,
            "output_file": str(shell.output_file) if shell.output_file else None,
        }

    def processes(self) -> dict[str, subprocess.Popen[str]]:
        with self._lock:
            return {
                shell_id: shell.process
                for shell_id, shell in self._processes.items()
                if shell.process.poll() is None
            }

    def background_jobs(self) -> tuple[BackgroundJobSummary, ...]:
        rows = self.list()
        return tuple(_background_job_from_row(row) for row in rows)

    def _drain_output(self, shell: ShellProcess) -> None:
        stdout = shell.process.stdout
        if stdout is None:
            return
        for line in stdout:
            with self._lock:
                shell.output.append(line)
                self._append_output_file_locked(shell, line)
                shell.last_observed_at = _now_iso()
        with contextlib.suppress(Exception):
            shell.process.wait()
        with self._lock:
            self._observe_locked(shell)
            notification = self._notification_for_locked(shell)
        if notification is not None and shell.notification_sink is not None:
            try:
                shell.notification_sink(notification)
            except Exception:
                return

    def _observe_locked(self, shell: ShellProcess) -> int | None:
        exit_code = shell.process.poll()
        shell.last_observed_at = _now_iso()
        if exit_code is None:
            return None
        if shell.terminal_state not in _TERMINAL_STATES:
            shell.terminal_state = "completed" if exit_code == 0 else "failed"
        return exit_code

    def _append_output_file_locked(self, shell: ShellProcess, text: str) -> None:
        if shell.output_file is None:
            return
        with shell.output_file.open("a", encoding="utf-8") as handle:
            handle.write(text)

    def _notification_for_locked(self, shell: ShellProcess) -> TaskNotification | None:
        if shell.notified or shell.terminal_state not in _TERMINAL_STATES:
            return None
        shell.notified = True
        status = shell.terminal_state or "completed"
        summary = _shell_summary(status=status, exit_code=shell.process.poll())
        return TaskNotification(
            task_id=f"shell:{shell.shell_id}",
            task_type="local_bash",
            status=status,
            summary=summary,
            output_file=shell.output_file,
            metadata={
                "shell_id": shell.shell_id,
                "exit_code": shell.process.poll(),
                "command_hash": shell.command_hash,
                "output_chars": sum(len(part) for part in shell.output),
            },
        )


def _now_iso() -> str:
    return datetime.now(tz=UTC).isoformat()


def _hash_command(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8")).hexdigest()[:12]


def _shell_summary(*, status: str, exit_code: int | None) -> str:
    if status == "completed":
        return "Background Bash command completed."
    if status == "failed":
        return f"Background Bash command failed with exit code {exit_code}."
    if status == "killed":
        return "Background Bash command was killed."
    if status == "timed_out":
        return "Background Bash command timed out."
    return f"Background Bash command finished with status {status}."


def _status_for_exit_code(exit_code: int | None, terminal_state: str | None) -> str:
    if terminal_state == "killed":
        return "killed"
    return "running" if exit_code is None else "exited"


def _process_state_for_exit_code(exit_code: int | None, terminal_state: str | None) -> str:
    if terminal_state:
        return terminal_state
    return "running_background" if exit_code is None else "completed"


def _background_job_from_row(row: dict[str, object]) -> BackgroundJobSummary:
    shell_id = str(row.get("shell_id") or "unknown")
    state = _background_state(row.get("process_state"), row.get("status"))
    output_chars = row.get("output_chars")
    timeout_seconds = row.get("timeout_seconds")
    return BackgroundJobSummary(
        job_id=f"shell:{shell_id}",
        owner="shell",
        state=state,
        started_at=_optional_str(row.get("started_at")),
        last_event_at=_optional_str(row.get("last_observed_at")),
        timeout_seconds=timeout_seconds if isinstance(timeout_seconds, int) else None,
        terminal_summary=_optional_str(row.get("terminal_state")),
        output_chars=output_chars if isinstance(output_chars, int) else None,
    )


def _background_state(process_state: object, status: object) -> BackgroundJobState:
    state = str(process_state or "")
    if state == "running_background" or status == "running":
        return "running"
    if state == "completed":
        return "completed"
    if state == "failed":
        return "failed"
    if state == "killed":
        return "killed"
    if state == "timed_out":
        return "timed_out"
    return "unknown"


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value


SHELL_REGISTRY = ShellProcessRegistry()

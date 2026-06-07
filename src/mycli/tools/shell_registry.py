from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
import hashlib
import os
import subprocess
import threading
import time
from uuid import uuid4


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
        )
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
        }

    def processes(self) -> dict[str, subprocess.Popen[str]]:
        with self._lock:
            return {
                shell_id: shell.process
                for shell_id, shell in self._processes.items()
                if shell.process.poll() is None
            }

    def _drain_output(self, shell: ShellProcess) -> None:
        stdout = shell.process.stdout
        if stdout is None:
            return
        for line in stdout:
            with self._lock:
                shell.output.append(line)
                shell.last_observed_at = _now_iso()
        with self._lock:
            self._observe_locked(shell)

    def _observe_locked(self, shell: ShellProcess) -> int | None:
        exit_code = shell.process.poll()
        shell.last_observed_at = _now_iso()
        if exit_code is None:
            return None
        if shell.terminal_state not in _TERMINAL_STATES:
            shell.terminal_state = "completed" if exit_code == 0 else "failed"
        return exit_code


def _now_iso() -> str:
    return datetime.now(tz=UTC).isoformat()


def _hash_command(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8")).hexdigest()[:12]


def _status_for_exit_code(exit_code: int | None, terminal_state: str | None) -> str:
    if terminal_state == "killed":
        return "killed"
    return "running" if exit_code is None else "exited"


def _process_state_for_exit_code(exit_code: int | None, terminal_state: str | None) -> str:
    if terminal_state:
        return terminal_state
    return "running_background" if exit_code is None else "completed"


SHELL_REGISTRY = ShellProcessRegistry()

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
import os
import subprocess
import threading
import time
from uuid import uuid4


@dataclass(slots=True)
class ShellProcess:
    shell_id: str
    command: str
    process: subprocess.Popen[str]
    started_at: str
    output: list[str] = field(default_factory=list)
    read_offset: int = 0


class ShellProcessRegistry:
    def __init__(self) -> None:
        self._processes: dict[str, ShellProcess] = {}
        self._lock = threading.Lock()

    def start(self, command: str, *, workdir: str | None = None) -> ShellProcess:
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=workdir or os.getcwd(),
            executable=os.environ.get("SHELL", "/bin/bash"),
        )
        shell = ShellProcess(
            shell_id=uuid4().hex[:8],
            command=command,
            process=process,
            started_at=datetime.now(tz=UTC).isoformat(),
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
            exit_code = shell.process.poll()
            return {
                "shell_id": shell.shell_id,
                "command": shell.command,
                "status": "running" if exit_code is None else "exited",
                "exit_code": exit_code,
                "output": output,
                "started_at": shell.started_at,
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
            return [
                {
                    "shell_id": shell.shell_id,
                    "command": shell.command,
                    "status": (
                        "running" if shell.process.poll() is None else "exited"
                    ),
                    "exit_code": shell.process.poll(),
                    "started_at": shell.started_at,
                }
                for shell in self._processes.values()
            ]

    def kill(self, shell_id: str) -> dict[str, object]:
        with self._lock:
            shell = self._processes.pop(shell_id, None)
        if shell is None:
            return {
                "error_kind": "shell_not_found",
                "error": f"No such shell: {shell_id}",
            }
        shell.process.terminate()
        try:
            shell.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            shell.process.kill()
            shell.process.wait()
        return {
            "status": "killed",
            "exit_code": shell.process.returncode,
            "shell_id": shell_id,
        }

    def processes(self) -> dict[str, subprocess.Popen[str]]:
        with self._lock:
            return {
                shell_id: shell.process
                for shell_id, shell in self._processes.items()
            }

    def _drain_output(self, shell: ShellProcess) -> None:
        stdout = shell.process.stdout
        if stdout is None:
            return
        for line in stdout:
            with self._lock:
                shell.output.append(line)


SHELL_REGISTRY = ShellProcessRegistry()

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from mycli.domain.runtime import ShellBackendProfile
from mycli.domain.runtime.task_notifications import TaskNotification


@dataclass(frozen=True, slots=True)
class ShellBackendRequest:
    command: str
    timeout_seconds: int
    cwd: str
    run_in_background: bool = False
    env: dict[str, str] | None = None
    command_pattern: str | None = None
    output_file: Path | None = None
    notification_sink: Callable[[TaskNotification], None] | None = None


class ShellBackend(Protocol):
    @property
    def profile(self) -> ShellBackendProfile:
        ...

    def execute(self, request: ShellBackendRequest) -> dict[str, Any]:
        ...


class LocalShellBackend:
    @property
    def profile(self) -> ShellBackendProfile:
        return ShellBackendProfile()

    def execute(self, request: ShellBackendRequest) -> dict[str, Any]:
        from mycli.tools.bash import execute_bash

        return execute_bash(
            request.command,
            timeout=request.timeout_seconds,
            workdir=request.cwd,
            run_in_background=request.run_in_background,
            env=request.env,
            command_pattern=request.command_pattern,
            output_file=request.output_file,
            notification_sink=request.notification_sink,
        )

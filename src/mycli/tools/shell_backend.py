from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from mycli.domain.runtime import (
    RuntimeInterruptToken,
    ShellBackendProfile,
    ShellLifecycleEvent,
)
from mycli.domain.runtime.task_notifications import TaskNotification


@dataclass(frozen=True, slots=True)
class ShellBackendRequest:
    command: str
    timeout_seconds: int
    cwd: str
    owner_session_id: str = "legacy"
    run_in_background: bool = False
    env: dict[str, str] | None = None
    command_pattern: str | None = None
    output_file: Path | None = None
    notification_sink: Callable[[TaskNotification], None] | None = None
    call_id: str | None = None
    lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None
    interrupt_token: RuntimeInterruptToken | None = None


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
            owner_session_id=request.owner_session_id,
            run_in_background=request.run_in_background,
            env=request.env,
            command_pattern=request.command_pattern,
            output_file=request.output_file,
            notification_sink=request.notification_sink,
            call_id=request.call_id,
            lifecycle_sink=request.lifecycle_sink,
            interrupt_token=request.interrupt_token,
        )

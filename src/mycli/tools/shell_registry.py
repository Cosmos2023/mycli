from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import subprocess
import time

from mycli.domain.runtime import RuntimeInterruptToken, ShellLifecycleEvent
from mycli.domain.runtime.background_jobs import BackgroundJobState, BackgroundJobSummary
from mycli.domain.runtime.task_notifications import TaskNotification
from mycli.tools.shell_session_manager import (
    ShellSessionManager,
    ShellSessionSnapshot,
    ShellStartRequest,
)


LEGACY_SHELL_OWNER = "legacy"
SHELL_SESSION_MANAGER = ShellSessionManager(output_max_chars=10_000)


class ShellProcessRegistry:
    """Compatibility facade over the session-aware shell process manager."""

    def __init__(self, manager: ShellSessionManager | None = None) -> None:
        self._manager = manager or SHELL_SESSION_MANAGER

    def execute(
        self,
        command: str,
        *,
        owner_session_id: str = LEGACY_SHELL_OWNER,
        workdir: str | None = None,
        env: dict[str, str] | None = None,
        timeout_seconds: int = 120,
        background: bool,
        command_pattern: str | None = None,
        output_file: Path | None = None,
        notification_sink: Callable[[TaskNotification], None] | None = None,
        call_id: str | None = None,
        lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> dict[str, object]:
        snapshot = self._manager.start(
            ShellStartRequest(
                owner_session_id=owner_session_id,
                command=command,
                cwd=Path(workdir or ".").resolve(),
                timeout_seconds=timeout_seconds,
                background=background,
                env=env,
                command_pattern=command_pattern,
                output_file=output_file,
                notification_sink=notification_sink,
                call_id=call_id,
                lifecycle_sink=lifecycle_sink,
                interrupt_token=interrupt_token,
            )
        )
        return _snapshot_payload(snapshot)

    def start(
        self,
        command: str,
        *,
        owner_session_id: str = LEGACY_SHELL_OWNER,
        workdir: str | None = None,
        env: dict[str, str] | None = None,
        timeout_seconds: int | None = None,
        command_pattern: str | None = None,
        output_file: Path | None = None,
        notification_sink: Callable[[TaskNotification], None] | None = None,
        call_id: str | None = None,
        lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None,
    ) -> ShellSessionSnapshot:
        return self._manager.start(
            ShellStartRequest(
                owner_session_id=owner_session_id,
                command=command,
                cwd=Path(workdir or ".").resolve(),
                timeout_seconds=120 if timeout_seconds is None else timeout_seconds,
                background=True,
                env=env,
                command_pattern=command_pattern,
                output_file=output_file,
                notification_sink=notification_sink,
                call_id=call_id,
                lifecycle_sink=lifecycle_sink,
            )
        )

    def read(
        self,
        shell_id: str,
        *,
        owner_session_id: str = LEGACY_SHELL_OWNER,
        cursor: int | None = None,
    ) -> dict[str, object]:
        deadline = time.monotonic() + 0.25
        snapshot = self._manager.poll(owner_session_id, shell_id, cursor=cursor)
        while (
            snapshot.success
            and not snapshot.output
            and snapshot.terminal_state is None
            and time.monotonic() < deadline
        ):
            time.sleep(0.01)
            snapshot = self._manager.poll(owner_session_id, shell_id, cursor=cursor)
        return _snapshot_payload(snapshot)

    def list(self, *, owner_session_id: str | None = None) -> list[dict[str, object]]:
        return [
            _snapshot_payload(snapshot)
            for snapshot in self._manager.list_sessions(owner_session_id)
            if snapshot.background
        ]

    def kill(
        self,
        shell_id: str,
        *,
        owner_session_id: str = LEGACY_SHELL_OWNER,
    ) -> dict[str, object]:
        snapshot = self._manager.terminate(owner_session_id, shell_id)
        payload = _snapshot_payload(snapshot)
        if snapshot.success:
            payload["status"] = snapshot.terminal_state or "killed"
        return payload

    def terminate_owner(self, owner_session_id: str) -> tuple[dict[str, object], ...]:
        return tuple(
            _snapshot_payload(snapshot)
            for snapshot in self._manager.terminate_owner(owner_session_id)
        )

    def processes(self) -> dict[str, subprocess.Popen[str]]:
        return self._manager.processes()

    def background_jobs(self) -> tuple[BackgroundJobSummary, ...]:
        return tuple(
            _background_job_from_row(row)
            for row in self.list()
        )


def _snapshot_payload(snapshot: ShellSessionSnapshot) -> dict[str, object]:
    if not snapshot.success:
        return {
            "shell_id": snapshot.shell_id,
            "status": snapshot.status,
            "process_state": snapshot.process_state,
            "error_kind": snapshot.error_kind,
            "error": snapshot.error,
        }
    return {
        "bash_id": snapshot.shell_id,
        "shell_id": snapshot.shell_id,
        "background": snapshot.background,
        "status": snapshot.status,
        "process_state": snapshot.process_state,
        "exit_code": snapshot.exit_code,
        "stdout": _render_bounded_output(
            snapshot.stdout,
            omitted_chars=snapshot.stdout_omitted_chars,
        ),
        "stderr": _render_bounded_output(
            snapshot.stderr,
            omitted_chars=snapshot.stderr_omitted_chars,
        ),
        "output": _render_bounded_output(
            snapshot.output,
            omitted_chars=snapshot.omitted_output_chars,
        ),
        "output_chars": snapshot.output_chars,
        "new_output_chars": snapshot.new_output_chars,
        "omitted_output_chars": snapshot.omitted_output_chars,
        "next_cursor": snapshot.next_cursor,
        "cursor_was_evicted": snapshot.cursor_was_evicted,
        "truncated": snapshot.omitted_output_chars > 0,
        "truncated_chars": snapshot.omitted_output_chars,
        "stdout_chars": snapshot.stdout_chars,
        "stderr_chars": snapshot.stderr_chars,
        "stdout_truncated": snapshot.stdout_omitted_chars > 0,
        "stderr_truncated": snapshot.stderr_omitted_chars > 0,
        "timed_out": snapshot.terminal_state == "timed_out",
        "started_at": snapshot.started_at,
        "last_observed_at": snapshot.last_observed_at,
        "completed_at": snapshot.completed_at,
        "cwd": snapshot.cwd,
        "timeout_seconds": snapshot.timeout_seconds,
        "command_hash": snapshot.command_hash,
        "command_length": snapshot.command_length,
        "command_pattern": snapshot.command_pattern,
        "terminal_state": snapshot.terminal_state,
        "cleanup_result": _compat_cleanup_result(snapshot.cleanup_result),
        "output_file": snapshot.output_file,
        "output_file_error": snapshot.output_file_error,
        "task_id": f"shell:{snapshot.shell_id}",
    }


def _render_bounded_output(output: str, *, omitted_chars: int) -> str:
    if omitted_chars <= 0 or not output:
        return output
    marker = f"\n... [... chars omitted] ({omitted_chars} chars) ...\n"
    if len(output) <= len(marker):
        return output
    available = len(output) - len(marker)
    head_chars = (available * 3) // 5
    tail_chars = available - head_chars
    return f"{output[:head_chars]}{marker}{output[-tail_chars:]}"


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
        completed_at=_optional_str(row.get("completed_at")),
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
    if state == "interrupted":
        return "cancelled"
    return "unknown"


def _optional_str(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value


def _compat_cleanup_result(value: str | None) -> str | None:
    if value == "sent_sigterm":
        return "terminated"
    if value == "sent_sigkill":
        return "killed_after_timeout"
    if value == "sent_sigint":
        return "interrupted"
    return value


SHELL_REGISTRY = ShellProcessRegistry()

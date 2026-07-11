from __future__ import annotations

import contextlib
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import os
from pathlib import Path
import signal
import subprocess
from threading import Lock, Thread
import time
from typing import Callable
from uuid import uuid4

from mycli.domain.runtime import RuntimeInterruptToken
from mycli.domain.runtime.task_notifications import TaskNotification
from mycli.tools.shell_output_buffer import ShellOutputBuffer


@dataclass(frozen=True, slots=True)
class ShellStartRequest:
    owner_session_id: str
    command: str
    cwd: Path
    timeout_seconds: int
    background: bool
    env: dict[str, str] | None = None
    command_pattern: str | None = None
    output_file: Path | None = None
    notification_sink: Callable[[TaskNotification], None] | None = None
    interrupt_token: RuntimeInterruptToken | None = None


@dataclass(frozen=True, slots=True)
class ShellSessionSnapshot:
    shell_id: str
    owner_session_id: str
    background: bool
    status: str
    process_state: str
    terminal_state: str | None
    exit_code: int | None
    output: str
    stdout: str
    stderr: str
    next_cursor: int
    output_chars: int
    new_output_chars: int
    omitted_output_chars: int
    stdout_chars: int
    stderr_chars: int
    stdout_omitted_chars: int
    stderr_omitted_chars: int
    cursor_was_evicted: bool
    cleanup_result: str | None
    started_at: str | None = None
    last_observed_at: str | None = None
    completed_at: str | None = None
    cwd: str | None = None
    timeout_seconds: int | None = None
    command_hash: str | None = None
    command_length: int | None = None
    command_pattern: str | None = None
    output_file: str | None = None
    output_file_error: str | None = None
    error_kind: str | None = None
    error: str | None = None

    @property
    def success(self) -> bool:
        return self.error_kind is None


@dataclass(slots=True)
class _ShellSession:
    shell_id: str
    owner_session_id: str
    background: bool
    command: str
    command_hash: str
    command_length: int
    command_pattern: str | None
    process: subprocess.Popen[str]
    started_at: str
    started_monotonic: float
    last_observed_at: str
    last_used_monotonic: float
    cwd: str
    timeout_seconds: int
    output: ShellOutputBuffer
    stdout: ShellOutputBuffer
    stderr: ShellOutputBuffer
    output_file: Path | None
    notification_sink: Callable[[TaskNotification], None] | None
    read_cursor: int = 0
    terminal_state: str | None = None
    cleanup_result: str | None = None
    completed_at: str | None = None
    output_file_error: str | None = None
    notified: bool = False


class ShellSessionManager:
    """Own local shell process lifecycle and bounded output retention."""

    def __init__(self, *, max_sessions: int = 64, output_max_chars: int = 1_048_576) -> None:
        if max_sessions <= 0:
            raise ValueError("max_sessions must be positive")
        if output_max_chars < 0:
            raise ValueError("output_max_chars must be non-negative")
        self._max_sessions = max_sessions
        self._output_max_chars = output_max_chars
        self._sessions: dict[str, _ShellSession] = {}
        self._lock = Lock()

    def start(self, request: ShellStartRequest) -> ShellSessionSnapshot:
        capacity_error = self._reserve_capacity(request.owner_session_id)
        if capacity_error is not None:
            return capacity_error

        output_file_error: str | None = None
        if request.output_file is not None:
            try:
                request.output_file.parent.mkdir(parents=True, exist_ok=True)
                request.output_file.write_text("", encoding="utf-8")
            except OSError as exc:
                output_file_error = str(exc)

        try:
            process = subprocess.Popen(
                request.command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                cwd=request.cwd,
                executable=os.environ.get("SHELL", "/bin/bash"),
                env=request.env,
                start_new_session=os.name == "posix",
                bufsize=1,
            )
        except OSError as exc:
            return self._error_snapshot(
                owner_session_id=request.owner_session_id,
                error_kind="shell_spawn_failed",
                error=str(exc),
            )

        now = _now_iso()
        started_monotonic = time.monotonic()
        session = _ShellSession(
            shell_id=uuid4().hex[:8],
            owner_session_id=request.owner_session_id,
            background=request.background,
            command=request.command,
            command_hash=_hash_command(request.command),
            command_length=len(request.command),
            command_pattern=request.command_pattern,
            process=process,
            started_at=now,
            started_monotonic=started_monotonic,
            last_observed_at=now,
            last_used_monotonic=started_monotonic,
            cwd=str(request.cwd),
            timeout_seconds=request.timeout_seconds,
            output=ShellOutputBuffer(max_chars=self._output_max_chars),
            stdout=ShellOutputBuffer(max_chars=self._output_max_chars),
            stderr=ShellOutputBuffer(max_chars=self._output_max_chars),
            output_file=request.output_file,
            notification_sink=request.notification_sink,
            output_file_error=output_file_error,
        )
        with self._lock:
            self._sessions[session.shell_id] = session

        stdout_thread = Thread(
            target=self._drain_stream,
            args=(session.shell_id, "stdout"),
            daemon=True,
        )
        stderr_thread = Thread(
            target=self._drain_stream,
            args=(session.shell_id, "stderr"),
            daemon=True,
        )
        stdout_thread.start()
        stderr_thread.start()
        Thread(
            target=self._watch_process,
            args=(session.shell_id, stdout_thread, stderr_thread),
            daemon=True,
        ).start()
        Thread(target=self._watch_timeout, args=(session.shell_id,), daemon=True).start()

        if request.interrupt_token is not None and not request.background:
            request.interrupt_token.add_callback(
                lambda: self._terminate(
                    request.owner_session_id,
                    session.shell_id,
                    terminal_state="interrupted",
                    prefer_interrupt=True,
                )
            )

        if not request.background:
            self._wait_for_terminal(session.shell_id)
        return self._snapshot(session, cursor=0, advance_cursor=False)

    def poll(
        self,
        owner_session_id: str,
        shell_id: str,
        *,
        cursor: int | None = None,
    ) -> ShellSessionSnapshot:
        session, error = self._owned_session(owner_session_id, shell_id)
        if error is not None:
            return error
        assert session is not None
        with self._lock:
            effective_cursor = session.read_cursor if cursor is None else cursor
            session.last_observed_at = _now_iso()
            session.last_used_monotonic = time.monotonic()
        return self._snapshot(session, cursor=effective_cursor, advance_cursor=cursor is None)

    def terminate(self, owner_session_id: str, shell_id: str) -> ShellSessionSnapshot:
        session, error = self._owned_session(owner_session_id, shell_id)
        if error is not None:
            return error
        assert session is not None
        self._terminate(
            owner_session_id,
            shell_id,
            terminal_state="killed",
            prefer_interrupt=False,
        )
        return self._snapshot(session, cursor=session.read_cursor, advance_cursor=False)

    def terminate_owner(self, owner_session_id: str) -> tuple[ShellSessionSnapshot, ...]:
        with self._lock:
            shell_ids = [
                shell_id
                for shell_id, session in self._sessions.items()
                if session.owner_session_id == owner_session_id
                and session.process.poll() is None
            ]
        return tuple(self.terminate(owner_session_id, shell_id) for shell_id in shell_ids)

    def list_sessions(self, owner_session_id: str | None = None) -> tuple[ShellSessionSnapshot, ...]:
        with self._lock:
            sessions = [
                session
                for session in self._sessions.values()
                if owner_session_id is None or session.owner_session_id == owner_session_id
            ]
            sessions.sort(key=lambda item: item.started_monotonic)
        return tuple(self._snapshot_full(session) for session in sessions)

    def processes(self) -> dict[str, subprocess.Popen[str]]:
        with self._lock:
            return {
                shell_id: session.process
                for shell_id, session in self._sessions.items()
                if session.process.poll() is None
            }

    def _reserve_capacity(self, owner_session_id: str) -> ShellSessionSnapshot | None:
        with self._lock:
            if len(self._sessions) < self._max_sessions:
                return None
            completed = [
                session
                for session in self._sessions.values()
                if session.process.poll() is not None
            ]
            if completed:
                candidate = min(completed, key=lambda item: item.last_used_monotonic)
                self._sessions.pop(candidate.shell_id, None)
                return None
        return self._error_snapshot(
            owner_session_id=owner_session_id,
            error_kind="shell_capacity_exceeded",
            error=f"Shell session capacity {self._max_sessions} is full.",
        )

    def _owned_session(
        self,
        owner_session_id: str,
        shell_id: str,
    ) -> tuple[_ShellSession | None, ShellSessionSnapshot | None]:
        with self._lock:
            session = self._sessions.get(shell_id)
            if session is None:
                return None, self._error_snapshot(
                    owner_session_id=owner_session_id,
                    shell_id=shell_id,
                    error_kind="shell_not_found",
                    error=f"No such shell: {shell_id}",
                )
            if session.owner_session_id != owner_session_id:
                return None, self._error_snapshot(
                    owner_session_id=owner_session_id,
                    shell_id=shell_id,
                    error_kind="shell_session_forbidden",
                    error=f"Shell {shell_id} belongs to another session.",
                )
            return session, None

    def _drain_stream(self, shell_id: str, stream_name: str) -> None:
        with self._lock:
            session = self._sessions.get(shell_id)
        if session is None:
            return
        stream = session.process.stdout if stream_name == "stdout" else session.process.stderr
        target = session.stdout if stream_name == "stdout" else session.stderr
        if stream is not None:
            for text in stream:
                target.append(text)
                session.output.append(text)
                self._append_output_file(session, text)
                with self._lock:
                    session.last_observed_at = _now_iso()

    def _watch_process(
        self,
        shell_id: str,
        stdout_thread: Thread,
        stderr_thread: Thread,
    ) -> None:
        with self._lock:
            session = self._sessions.get(shell_id)
        if session is None:
            return
        with contextlib.suppress(Exception):
            session.process.wait()
        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
        self._finalize_natural(session)

    def _watch_timeout(self, shell_id: str) -> None:
        with self._lock:
            session = self._sessions.get(shell_id)
        if session is None:
            return
        try:
            session.process.wait(timeout=max(0, session.timeout_seconds))
        except subprocess.TimeoutExpired:
            self._terminate(
                session.owner_session_id,
                shell_id,
                terminal_state="timed_out",
                prefer_interrupt=False,
            )

    def _wait_for_terminal(self, shell_id: str) -> None:
        while True:
            with self._lock:
                session = self._sessions.get(shell_id)
                if session is None or session.terminal_state is not None:
                    return
            time.sleep(0.01)

    def _terminate(
        self,
        owner_session_id: str,
        shell_id: str,
        *,
        terminal_state: str,
        prefer_interrupt: bool,
    ) -> None:
        session, error = self._owned_session(owner_session_id, shell_id)
        if error is not None or session is None:
            return
        with self._lock:
            if session.terminal_state is not None:
                return
            session.terminal_state = terminal_state
            session.last_observed_at = _now_iso()

        cleanup_result = _terminate_process_group(
            session.process,
            prefer_interrupt=prefer_interrupt,
        )
        with self._lock:
            session.cleanup_result = cleanup_result
            session.completed_at = _now_iso()
            session.last_observed_at = session.completed_at
            notification = self._notification_for_locked(session)
        self._deliver_notification(session, notification)

    def _finalize_natural(self, session: _ShellSession) -> None:
        with self._lock:
            if session.terminal_state is not None:
                return
            exit_code = session.process.poll()
            session.terminal_state = "completed" if exit_code == 0 else "failed"
            session.cleanup_result = "not_needed"
            session.completed_at = _now_iso()
            session.last_observed_at = session.completed_at
            notification = self._notification_for_locked(session)
        self._deliver_notification(session, notification)

    def _notification_for_locked(self, session: _ShellSession) -> TaskNotification | None:
        if session.notified or session.terminal_state is None:
            return None
        session.notified = True
        snapshot = session.output.snapshot()
        return TaskNotification(
            task_id=f"shell:{session.shell_id}",
            task_type="local_bash",
            status=session.terminal_state,
            summary=_shell_summary(
                status=session.terminal_state,
                exit_code=session.process.poll(),
            ),
            output_file=session.output_file,
            completed_at=session.completed_at,
            metadata={
                "shell_id": session.shell_id,
                "exit_code": session.process.poll(),
                "command_hash": session.command_hash,
                "output_chars": snapshot.total_chars,
                "omitted_output_chars": snapshot.omitted_chars,
            },
        )

    def _deliver_notification(
        self,
        session: _ShellSession,
        notification: TaskNotification | None,
    ) -> None:
        if notification is None or session.notification_sink is None:
            return
        with contextlib.suppress(Exception):
            session.notification_sink(notification)

    def _append_output_file(self, session: _ShellSession, text: str) -> None:
        if session.output_file is None or session.output_file_error is not None:
            return
        try:
            with session.output_file.open("a", encoding="utf-8") as handle:
                handle.write(text)
        except OSError as exc:
            with self._lock:
                session.output_file_error = str(exc)

    def _snapshot(
        self,
        session: _ShellSession,
        *,
        cursor: int,
        advance_cursor: bool,
    ) -> ShellSessionSnapshot:
        chunk = session.output.read_from(cursor)
        if advance_cursor:
            with self._lock:
                session.read_cursor = chunk.next_cursor
        return self._snapshot_from_output(
            session,
            output=chunk.text,
            next_cursor=chunk.next_cursor,
            new_output_chars=len(chunk.text),
            cursor_was_evicted=chunk.cursor_was_evicted,
            omitted_before_chunk=chunk.omitted_before_chunk,
        )

    def _snapshot_full(self, session: _ShellSession) -> ShellSessionSnapshot:
        output = session.output.snapshot()
        return self._snapshot_from_output(
            session,
            output=output.text,
            next_cursor=output.total_chars,
            new_output_chars=len(output.text),
            cursor_was_evicted=output.omitted_chars > 0,
            omitted_before_chunk=output.omitted_chars,
        )

    def _snapshot_from_output(
        self,
        session: _ShellSession,
        *,
        output: str,
        next_cursor: int,
        new_output_chars: int,
        cursor_was_evicted: bool,
        omitted_before_chunk: int,
    ) -> ShellSessionSnapshot:
        retained = session.output.snapshot()
        stdout = session.stdout.snapshot()
        stderr = session.stderr.snapshot()
        with self._lock:
            terminal_state = session.terminal_state
            exit_code = session.process.poll()
            session.last_used_monotonic = time.monotonic()
            return ShellSessionSnapshot(
                shell_id=session.shell_id,
                owner_session_id=session.owner_session_id,
                background=session.background,
                status="running" if terminal_state is None else "exited",
                process_state=terminal_state or "running_background",
                terminal_state=terminal_state,
                exit_code=exit_code,
                output=output,
                stdout=stdout.text,
                stderr=stderr.text,
                next_cursor=next_cursor,
                output_chars=retained.total_chars,
                new_output_chars=new_output_chars,
                omitted_output_chars=max(retained.omitted_chars, omitted_before_chunk),
                stdout_chars=stdout.total_chars,
                stderr_chars=stderr.total_chars,
                stdout_omitted_chars=stdout.omitted_chars,
                stderr_omitted_chars=stderr.omitted_chars,
                cursor_was_evicted=cursor_was_evicted,
                cleanup_result=session.cleanup_result,
                started_at=session.started_at,
                last_observed_at=session.last_observed_at,
                completed_at=session.completed_at,
                cwd=session.cwd,
                timeout_seconds=session.timeout_seconds,
                command_hash=session.command_hash,
                command_length=session.command_length,
                command_pattern=session.command_pattern,
                output_file=str(session.output_file) if session.output_file else None,
                output_file_error=session.output_file_error,
            )

    def _error_snapshot(
        self,
        *,
        owner_session_id: str,
        error_kind: str,
        error: str,
        shell_id: str = "",
    ) -> ShellSessionSnapshot:
        return ShellSessionSnapshot(
            shell_id=shell_id,
            owner_session_id=owner_session_id,
            background=False,
            status="error",
            process_state="failed",
            terminal_state="failed",
            exit_code=None,
            output="",
            stdout="",
            stderr="",
            next_cursor=0,
            output_chars=0,
            new_output_chars=0,
            omitted_output_chars=0,
            stdout_chars=0,
            stderr_chars=0,
            stdout_omitted_chars=0,
            stderr_omitted_chars=0,
            cursor_was_evicted=False,
            cleanup_result=None,
            error_kind=error_kind,
            error=error,
        )


def _terminate_process_group(
    process: subprocess.Popen[str],
    *,
    prefer_interrupt: bool,
) -> str:
    signals: tuple[tuple[signal.Signals, str], ...] = (
        (signal.SIGINT, "sent_sigint"),
        (signal.SIGTERM, "sent_sigterm"),
        (signal.SIGKILL, "sent_sigkill"),
    )
    if not prefer_interrupt:
        signals = signals[1:]
    cleanup_result = "already_exited"
    for sig, label in signals:
        if process.poll() is not None:
            return cleanup_result
        try:
            if os.name == "posix":
                os.killpg(process.pid, sig)
            else:
                process.send_signal(sig)
            cleanup_result = label
        except ProcessLookupError:
            return cleanup_result
        except PermissionError:
            cleanup_result = f"{label}_permission_denied"
            continue
        try:
            process.wait(timeout=0.5 if sig != signal.SIGTERM else 2.0)
            return cleanup_result
        except subprocess.TimeoutExpired:
            continue
    return cleanup_result


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
    if status == "interrupted":
        return "Background Bash command was interrupted."
    return f"Background Bash command finished with status {status}."

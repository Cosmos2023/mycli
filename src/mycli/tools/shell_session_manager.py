from __future__ import annotations

import contextlib
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
import hashlib
from pathlib import Path
import subprocess
from threading import Lock, Thread
import time
from typing import Any, cast
from uuid import uuid4

from mycli.domain.runtime import (
    RuntimeInterruptToken,
    ShellKind,
    ShellLifecycleEvent,
    ShellLifecycleKind,
    ShellProfile,
)
from mycli.domain.runtime.task_notifications import TaskNotification
from mycli.tools.process_controller import (
    ProcessTerminationOutcome,
    process_spawn_options,
    terminate_process_tree,
)
from mycli.tools.shell_output_buffer import ShellOutputBuffer
from mycli.tools.shell_resolver import (
    ShellCommandConfig,
    ShellResolutionError,
    resolve_shell,
)


ShellResolver = Callable[[str | None], ShellCommandConfig]
ProcessFactory = Callable[..., subprocess.Popen[str]]
ProcessTerminator = Callable[[subprocess.Popen[str], bool], ProcessTerminationOutcome]


@dataclass(frozen=True, slots=True)
class ShellStartRequest:
    owner_session_id: str
    command: str
    cwd: Path
    timeout_seconds: int
    background: bool
    shell_path: str | None = None
    shell_profile: ShellProfile | None = None
    env: dict[str, str] | None = None
    command_pattern: str | None = None
    output_file: Path | None = None
    notification_sink: Callable[[TaskNotification], None] | None = None
    call_id: str | None = None
    lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None
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
    shell_kind: str | None = None
    shell_edition: str | None = None
    call_id: str | None = None
    command_preview: str | None = None
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
    shell_profile: ShellProfile
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
    call_id: str | None
    lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None
    read_cursor: int = 0
    event_sequence: int = 0
    lifecycle_cursor: int = 0
    lifecycle_omitted_chars: int = 0
    output_event_scheduled: bool = False
    lifecycle_terminal_emitted: bool = False
    lifecycle_delivery_lock: Lock = field(default_factory=Lock)
    terminal_state: str | None = None
    cleanup_result: str | None = None
    completed_at: str | None = None
    output_file_error: str | None = None
    notified: bool = False


class ShellSessionManager:
    """Own local shell process lifecycle and bounded output retention."""

    def __init__(
        self,
        *,
        max_sessions: int = 64,
        output_max_chars: int = 1_048_576,
        output_event_interval_seconds: float = 0.05,
        output_event_max_chars: int = 4096,
        shell_resolver: ShellResolver | None = None,
        process_factory: ProcessFactory | None = None,
        process_terminator: ProcessTerminator | None = None,
    ) -> None:
        if max_sessions <= 0:
            raise ValueError("max_sessions must be positive")
        if output_max_chars < 0:
            raise ValueError("output_max_chars must be non-negative")
        if output_event_interval_seconds < 0:
            raise ValueError("output_event_interval_seconds must be non-negative")
        if output_event_max_chars <= 0:
            raise ValueError("output_event_max_chars must be positive")
        self._max_sessions = max_sessions
        self._output_max_chars = output_max_chars
        self._output_event_interval_seconds = output_event_interval_seconds
        self._output_event_max_chars = output_event_max_chars
        self._shell_resolver = shell_resolver or resolve_shell
        self._process_factory = process_factory or _spawn_process
        self._process_terminator = process_terminator or _terminate_process
        self._sessions: dict[str, _ShellSession] = {}
        self._pending_starts = 0
        self._lock = Lock()

    def start(self, request: ShellStartRequest) -> ShellSessionSnapshot:
        capacity_error, removed_delivery = self._reserve_capacity(request.owner_session_id)
        self._deliver_lifecycle_delivery(removed_delivery)
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
            if request.shell_profile is None:
                legacy_shell = self._shell_resolver(request.shell_path)
                shell_profile = ShellProfile(ShellKind.BASH, legacy_shell.executable)
            else:
                shell_profile = request.shell_profile
            process = self._process_factory(
                shell_profile.exec_argv(request.command),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                cwd=request.cwd,
                env=request.env,
                bufsize=1,
                **process_spawn_options(),
            )
        except ShellResolutionError as exc:
            self._release_capacity_reservation()
            return self._error_snapshot(
                owner_session_id=request.owner_session_id,
                error_kind="shell_resolution_failed",
                error=str(exc),
            )
        except OSError as exc:
            self._release_capacity_reservation()
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
            shell_profile=shell_profile,
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
            call_id=request.call_id,
            lifecycle_sink=request.lifecycle_sink,
            output_file_error=output_file_error,
        )
        with self._lock:
            self._pending_starts -= 1
            self._sessions[session.shell_id] = session
            started_event = self._next_event_locked(session, kind="shell.started")
            list_event = (
                self._next_event_locked(
                    session,
                    kind="shell.list.updated",
                    active_background_count=self._active_background_count_locked(
                        session.owner_session_id
                    ),
                )
                if session.background
                else None
            )

        self._deliver_lifecycle_event(session, started_event)
        self._deliver_lifecycle_event(session, list_event)

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

    def _reserve_capacity(
        self,
        owner_session_id: str,
    ) -> tuple[
        ShellSessionSnapshot | None,
        tuple[Callable[[ShellLifecycleEvent], None] | None, ShellLifecycleEvent] | None,
    ]:
        with self._lock:
            if len(self._sessions) + self._pending_starts < self._max_sessions:
                self._pending_starts += 1
                return None, None
            completed = [
                session
                for session in self._sessions.values()
                if session.process.poll() is not None
                and session.terminal_state is not None
                and (
                    session.lifecycle_sink is None
                    or session.lifecycle_terminal_emitted
                )
            ]
            if completed:
                candidate = min(completed, key=lambda item: item.last_used_monotonic)
                removed_event = self._next_event_locked(candidate, kind="shell.removed")
                self._sessions.pop(candidate.shell_id, None)
                self._pending_starts += 1
                return None, (candidate.lifecycle_sink, removed_event)
        return (
            self._error_snapshot(
                owner_session_id=owner_session_id,
                error_kind="shell_capacity_exceeded",
                error=f"Shell session capacity {self._max_sessions} is full.",
            ),
            None,
        )

    def _release_capacity_reservation(self) -> None:
        with self._lock:
            self._pending_starts -= 1

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
                schedule_output = False
                with self._lock:
                    session.last_observed_at = _now_iso()
                    if (
                        session.lifecycle_sink is not None
                        and not session.lifecycle_terminal_emitted
                        and not session.output_event_scheduled
                    ):
                        session.output_event_scheduled = True
                        schedule_output = True
                if schedule_output:
                    Thread(
                        target=self._flush_output_after_delay,
                        args=(session.shell_id,),
                        daemon=True,
                    ).start()

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
        stdout_thread.join()
        stderr_thread.join()
        self._finalize_natural(session)
        self._finalize_lifecycle(session)

    def _flush_output_after_delay(self, shell_id: str) -> None:
        time.sleep(self._output_event_interval_seconds)
        self._flush_lifecycle_output(shell_id)

    def _flush_lifecycle_output(self, shell_id: str) -> None:
        with self._lock:
            session = self._sessions.get(shell_id)
        if session is None:
            return
        with session.lifecycle_delivery_lock:
            with self._lock:
                if session.lifecycle_terminal_emitted:
                    session.output_event_scheduled = False
                    return
                session.output_event_scheduled = False
                output_event = self._output_event_locked(session)
            self._deliver_lifecycle_event_unlocked(session, output_event)

    def _finalize_lifecycle(self, session: _ShellSession) -> None:
        with session.lifecycle_delivery_lock:
            with self._lock:
                if session.lifecycle_terminal_emitted:
                    return
                session.output_event_scheduled = False
                output_event = self._output_event_locked(session)
                session.lifecycle_terminal_emitted = True
                completed_event = self._next_event_locked(
                    session,
                    kind="shell.completed",
                )
                list_event = (
                    self._next_event_locked(
                        session,
                        kind="shell.list.updated",
                        active_background_count=self._active_background_count_locked(
                            session.owner_session_id
                        ),
                    )
                    if session.background
                    else None
                )
            self._deliver_lifecycle_event_unlocked(session, output_event)
            self._deliver_lifecycle_event_unlocked(session, completed_event)
            self._deliver_lifecycle_event_unlocked(session, list_event)

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

        outcome = self._process_terminator(session.process, prefer_interrupt)
        with self._lock:
            session.cleanup_result = outcome.cleanup_result
            if not outcome.terminal:
                session.terminal_state = None
                session.last_observed_at = _now_iso()
                return
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

    def _active_background_count_locked(self, owner_session_id: str) -> int:
        return sum(
            1
            for session in self._sessions.values()
            if session.owner_session_id == owner_session_id
            and session.background
            and session.terminal_state is None
        )

    def _output_event_locked(
        self,
        session: _ShellSession,
    ) -> ShellLifecycleEvent | None:
        chunk = session.output.read_from(session.lifecycle_cursor)
        session.lifecycle_cursor = chunk.next_cursor
        if not chunk.text:
            return None
        output_delta = chunk.text
        discarded_chars = max(0, len(output_delta) - self._output_event_max_chars)
        if discarded_chars:
            output_delta = output_delta[-self._output_event_max_chars :]
        session.lifecycle_omitted_chars += (
            chunk.omitted_before_chunk + discarded_chars
        )
        return self._next_event_locked(
            session,
            kind="shell.output",
            output_delta=output_delta,
            next_cursor=chunk.next_cursor,
        )

    def _next_event_locked(
        self,
        session: _ShellSession,
        *,
        kind: ShellLifecycleKind,
        output_delta: str = "",
        next_cursor: int | None = None,
        active_background_count: int | None = None,
    ) -> ShellLifecycleEvent:
        session.event_sequence += 1
        output = session.output.snapshot()
        process_state = session.terminal_state or (
            "running_background" if session.background else "running_foreground"
        )
        return ShellLifecycleEvent(
            kind=kind,
            shell_id=session.shell_id,
            owner_session_id=session.owner_session_id,
            call_id=session.call_id,
            sequence=session.event_sequence,
            command_preview=_command_preview(session.command),
            background=session.background,
            process_state=process_state,
            terminal_state=session.terminal_state,
            exit_code=session.process.poll(),
            output_delta=output_delta,
            next_cursor=output.total_chars if next_cursor is None else next_cursor,
            output_chars=output.total_chars,
            omitted_output_chars=max(
                output.omitted_chars,
                session.lifecycle_omitted_chars,
            ),
            cleanup_result=session.cleanup_result,
            started_at=session.started_at,
            completed_at=session.completed_at,
            active_background_count=active_background_count,
        )

    def _deliver_lifecycle_event(
        self,
        session: _ShellSession,
        event: ShellLifecycleEvent | None,
    ) -> None:
        if event is None:
            return
        with session.lifecycle_delivery_lock:
            self._deliver_lifecycle_event_unlocked(session, event)

    def _deliver_lifecycle_event_unlocked(
        self,
        session: _ShellSession,
        event: ShellLifecycleEvent | None,
    ) -> None:
        if event is None or session.lifecycle_sink is None:
            return
        with contextlib.suppress(Exception):
            session.lifecycle_sink(event)

    def _deliver_lifecycle_delivery(
        self,
        delivery: tuple[
            Callable[[ShellLifecycleEvent], None] | None,
            ShellLifecycleEvent,
        ]
        | None,
    ) -> None:
        if delivery is None:
            return
        sink, event = delivery
        if sink is None:
            return
        with contextlib.suppress(Exception):
            sink(event)

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
                process_state=terminal_state
                or (
                    "running_background"
                    if session.background
                    else "running_foreground"
                ),
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
                shell_kind=session.shell_profile.kind.value,
                shell_edition=(
                    session.shell_profile.powershell_edition.value
                    if session.shell_profile.powershell_edition is not None
                    else None
                ),
                call_id=session.call_id,
                command_preview=_command_preview(session.command),
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


def _spawn_process(command: list[str], **kwargs: Any) -> subprocess.Popen[str]:
    return cast("subprocess.Popen[str]", subprocess.Popen(command, **kwargs))


def _terminate_process(
    process: subprocess.Popen[str],
    prefer_interrupt: bool,
) -> ProcessTerminationOutcome:
    return terminate_process_tree(process, prefer_interrupt=prefer_interrupt)


def _now_iso() -> str:
    return datetime.now(tz=UTC).isoformat()


def _hash_command(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8")).hexdigest()[:12]


def _command_preview(command: str) -> str:
    preview = " ".join(command.split())
    if len(preview) <= 160:
        return preview
    return f"{preview[:157]}..."


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

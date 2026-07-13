from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
from threading import Event, Lock, Thread
import time

import pytest

from mycli.domain.runtime import ShellLifecycleEvent
from mycli.domain.runtime.task_notifications import TaskNotification
from mycli.tools.process_controller import ProcessTerminationOutcome
from mycli.tools.shell_resolver import ShellCommandConfig, ShellResolutionError
from mycli.tools.shell_session_manager import ShellSessionManager, ShellStartRequest


def _request(
    tmp_path: Path,
    command: str,
    *,
    owner: str = "session-a",
    timeout_seconds: int = 30,
) -> ShellStartRequest:
    return ShellStartRequest(
        owner_session_id=owner,
        command=command,
        cwd=tmp_path,
        timeout_seconds=timeout_seconds,
        background=True,
    )


def _wait_for_terminal(
    manager: ShellSessionManager,
    owner: str,
    shell_id: str,
    *,
    timeout: float = 3.0,
):
    deadline = time.monotonic() + timeout
    snapshot = manager.poll(owner, shell_id)
    while snapshot.terminal_state is None and time.monotonic() < deadline:
        time.sleep(0.01)
        snapshot = manager.poll(owner, shell_id)
    return snapshot


def _wait_for_output(
    manager: ShellSessionManager,
    owner: str,
    shell_id: str,
    *,
    timeout: float = 3.0,
):
    deadline = time.monotonic() + timeout
    snapshot = manager.poll(owner, shell_id)
    while not snapshot.output and time.monotonic() < deadline:
        time.sleep(0.01)
        snapshot = manager.poll(owner, shell_id, cursor=0)
    return snapshot


def test_manager_spawns_resolved_shell_without_shell_true(tmp_path: Path) -> None:
    captured: list[tuple[object, dict[str, object]]] = []

    def failing_factory(command: object, **kwargs: object):
        captured.append((command, kwargs))
        raise OSError("stop after capture")

    manager = ShellSessionManager(
        shell_resolver=lambda _path: ShellCommandConfig(Path("/custom/bash")),
        process_factory=failing_factory,
    )

    result = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="printf ok",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            shell_path="/custom/bash",
        )
    )

    assert result.error_kind == "shell_spawn_failed"
    command, kwargs = captured[0]
    assert command == ["/custom/bash", "-c", "printf ok"]
    assert "shell" not in kwargs
    assert "executable" not in kwargs


def test_manager_does_not_register_failed_shell_resolution(tmp_path: Path) -> None:
    def missing_shell(_path: str | None) -> ShellCommandConfig:
        raise ShellResolutionError("Install Git for Windows")

    manager = ShellSessionManager(shell_resolver=missing_shell)

    result = manager.start(_request(tmp_path, "printf ok"))

    assert result.error_kind == "shell_resolution_failed"
    assert "Install Git for Windows" in str(result.error)
    assert manager.list_sessions("session-a") == ()


def test_manager_uses_process_terminator_result(tmp_path: Path) -> None:
    calls: list[bool] = []

    def terminate(_process: subprocess.Popen[str], prefer_interrupt: bool):
        calls.append(prefer_interrupt)
        _process.terminate()
        _process.wait(timeout=2)
        return ProcessTerminationOutcome("controller_terminated", terminal=True)

    manager = ShellSessionManager(process_terminator=terminate)
    started = manager.start(_request(tmp_path, "sleep 30"))

    snapshot = manager.terminate("session-a", started.shell_id)

    assert calls == [False]
    assert snapshot.cleanup_result == "controller_terminated"


def test_manager_keeps_running_state_when_process_termination_fails(
    tmp_path: Path,
) -> None:
    manager = ShellSessionManager(
        process_terminator=lambda _process, _prefer_interrupt: ProcessTerminationOutcome(
            "taskkill_failed",
            terminal=False,
            error="access denied",
        )
    )
    started = manager.start(_request(tmp_path, "sleep 30"))

    snapshot = manager.terminate("session-a", started.shell_id)

    assert snapshot.status == "running"
    assert snapshot.terminal_state is None
    assert snapshot.cleanup_result == "taskkill_failed"
    process = manager.processes()[started.shell_id]
    process.terminate()
    process.wait(timeout=2)


def test_shell_lifecycle_event_projects_safe_tui_payload() -> None:
    event = ShellLifecycleEvent(
        kind="shell.started",
        shell_id="shell-1",
        owner_session_id="session-a",
        call_id="call-1",
        sequence=1,
        command_preview="python3 -m http.server",
        background=True,
        process_state="running_background",
        output_delta="",
        next_cursor=0,
        output_chars=0,
        omitted_output_chars=0,
    )

    payload = event.to_tui_payload()

    assert payload["shell_id"] == "shell-1"
    assert payload["call_id"] == "call-1"
    assert payload["sequence"] == 1
    assert payload["command_preview"] == "python3 -m http.server"
    assert "owner_session_id" not in payload


def _wait_for_lifecycle_kind(
    events: list[ShellLifecycleEvent],
    kind: str,
    *,
    timeout: float = 2.0,
) -> None:
    deadline = time.monotonic() + timeout
    while not any(event.kind == kind for event in events) and time.monotonic() < deadline:
        time.sleep(0.01)


def test_manager_emits_started_output_and_completed_in_order(tmp_path: Path) -> None:
    events: list[ShellLifecycleEvent] = []
    manager = ShellSessionManager(
        max_sessions=8,
        output_max_chars=1024,
        output_event_interval_seconds=0.01,
        output_event_max_chars=4096,
    )
    started = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            call_id="call-a",
            command="printf 'one\ntwo\n'",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            lifecycle_sink=events.append,
        )
    )

    snapshot = _wait_for_terminal(manager, "session-a", started.shell_id)
    _wait_for_lifecycle_kind(events, "shell.completed")

    assert snapshot.terminal_state == "completed"
    assert events[0].kind == "shell.started"
    assert any(
        event.kind == "shell.output" and "one" in event.output_delta
        for event in events
    )
    assert next(
        index for index, event in enumerate(events) if event.kind == "shell.completed"
    ) > next(index for index, event in enumerate(events) if event.kind == "shell.output")
    assert [event.sequence for event in events] == sorted(
        event.sequence for event in events
    )
    assert next(event for event in events if event.kind == "shell.completed").call_id == "call-a"


def test_manager_caps_output_event_delta_and_flushes_before_terminal(
    tmp_path: Path,
) -> None:
    events: list[ShellLifecycleEvent] = []
    manager = ShellSessionManager(
        max_sessions=8,
        output_max_chars=4096,
        output_event_interval_seconds=0.01,
        output_event_max_chars=32,
    )
    started = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="python3 -c \"print('x' * 200)\"",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            lifecycle_sink=events.append,
        )
    )

    _wait_for_terminal(manager, "session-a", started.shell_id)
    _wait_for_lifecycle_kind(events, "shell.completed")

    output_events = [event for event in events if event.kind == "shell.output"]
    assert output_events
    assert all(len(event.output_delta) <= 32 for event in output_events)
    terminal_index = next(
        index for index, event in enumerate(events) if event.kind == "shell.completed"
    )
    assert all(event.kind != "shell.output" for event in events[terminal_index + 1 :])
    assert events[terminal_index].output_chars >= 200


def test_manager_emits_owner_background_counts(tmp_path: Path) -> None:
    events: list[ShellLifecycleEvent] = []
    manager = ShellSessionManager(max_sessions=8, output_max_chars=1024)
    started = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="sleep 30",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            lifecycle_sink=events.append,
        )
    )

    assert any(
        event.kind == "shell.list.updated" and event.active_background_count == 1
        for event in events
    )

    manager.terminate("session-a", started.shell_id)
    _wait_for_lifecycle_kind(events, "shell.completed")

    assert any(
        event.kind == "shell.list.updated" and event.active_background_count == 0
        for event in events
    )


def test_manager_emits_removed_when_pruning_completed_session(tmp_path: Path) -> None:
    events: list[ShellLifecycleEvent] = []
    manager = ShellSessionManager(max_sessions=2, output_max_chars=128)
    running = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="sleep 30",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            lifecycle_sink=events.append,
        )
    )
    completed = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="printf done",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            lifecycle_sink=events.append,
        )
    )
    _wait_for_terminal(manager, "session-a", completed.shell_id)
    _wait_for_lifecycle_kind(events, "shell.completed")

    replacement = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="sleep 30",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            lifecycle_sink=events.append,
        )
    )

    try:
        removed = [
            event
            for event in events
            if event.kind == "shell.removed" and event.shell_id == completed.shell_id
        ]
        assert len(removed) == 1
    finally:
        manager.terminate("session-a", running.shell_id)
        manager.terminate("session-a", replacement.shell_id)


def test_background_timeout_completes_without_polling(tmp_path: Path) -> None:
    manager = ShellSessionManager(max_sessions=8, output_max_chars=1024)
    started = manager.start(
        _request(
            tmp_path,
            "python3 -c 'import time; time.sleep(30)'",
            timeout_seconds=0,
        )
    )

    time.sleep(0.1)
    snapshot = _wait_for_terminal(manager, "session-a", started.shell_id)

    assert snapshot.terminal_state == "timed_out"
    assert snapshot.process_state == "timed_out"
    assert snapshot.cleanup_result is not None


def test_manager_rejects_cross_session_poll(tmp_path: Path) -> None:
    manager = ShellSessionManager(max_sessions=8, output_max_chars=1024)
    started = manager.start(_request(tmp_path, "sleep 30"))
    try:
        result = manager.poll("session-b", started.shell_id)
        assert result.error_kind == "shell_session_forbidden"
    finally:
        manager.terminate("session-a", started.shell_id)


def test_manager_bounds_retained_output(tmp_path: Path) -> None:
    manager = ShellSessionManager(max_sessions=8, output_max_chars=32)
    started = manager.start(
        _request(tmp_path, "python3 -c \"print('x' * 500)\"")
    )

    snapshot = _wait_for_terminal(manager, "session-a", started.shell_id)

    assert snapshot.output_chars >= 500
    assert len(snapshot.output) <= 32
    assert snapshot.omitted_output_chars > 0


def test_background_completion_notifies_once_after_repeated_polling(
    tmp_path: Path,
) -> None:
    notifications: list[TaskNotification] = []
    manager = ShellSessionManager(max_sessions=8, output_max_chars=1024)
    started = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="printf done",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            notification_sink=notifications.append,
        )
    )

    snapshot = _wait_for_terminal(manager, "session-a", started.shell_id)
    for _ in range(5):
        manager.poll("session-a", started.shell_id)

    assert snapshot.terminal_state == "completed"
    assert len(notifications) == 1
    assert notifications[0].task_id == f"shell:{started.shell_id}"
    assert notifications[0].status == "completed"


def test_foreground_snapshot_preserves_stdout_and_stderr(tmp_path: Path) -> None:
    manager = ShellSessionManager(max_sessions=8, output_max_chars=1024)
    snapshot = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command=(
                "python3 -c \"import sys; print('out'); "
                "sys.stderr.write('err\\n'); sys.exit(7)\""
            ),
            cwd=tmp_path,
            timeout_seconds=30,
            background=False,
        )
    )

    assert snapshot.exit_code == 7
    assert snapshot.background is False
    assert snapshot.stdout == "out\n"
    assert snapshot.stderr == "err\n"


def test_manager_prunes_completed_session_before_running_session(tmp_path: Path) -> None:
    manager = ShellSessionManager(max_sessions=2, output_max_chars=128)
    running = manager.start(_request(tmp_path, "sleep 30"))
    completed = manager.start(_request(tmp_path, "printf done"))
    _wait_for_terminal(manager, "session-a", completed.shell_id)

    replacement = manager.start(_request(tmp_path, "sleep 30"))

    try:
        shell_ids = {item.shell_id for item in manager.list_sessions("session-a")}
        assert running.shell_id in shell_ids
        assert replacement.shell_id in shell_ids
        assert completed.shell_id not in shell_ids
    finally:
        manager.terminate("session-a", running.shell_id)
        manager.terminate("session-a", replacement.shell_id)


def test_concurrent_starts_respect_session_capacity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager = ShellSessionManager(max_sessions=1, output_max_chars=128)
    first_spawn_entered = Event()
    release_first_spawn = Event()
    call_lock = Lock()
    spawn_calls = 0
    real_popen = subprocess.Popen

    def blocking_popen(*args: object, **kwargs: object):
        nonlocal spawn_calls
        with call_lock:
            spawn_calls += 1
            call_number = spawn_calls
        if call_number == 1:
            first_spawn_entered.set()
            assert release_first_spawn.wait(timeout=2)
        return real_popen(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", blocking_popen)
    results = []
    first = Thread(
        target=lambda: results.append(manager.start(_request(tmp_path, "sleep 30"))),
    )
    first.start()
    assert first_spawn_entered.wait(timeout=2)

    results.append(manager.start(_request(tmp_path, "sleep 30")))
    release_first_spawn.set()
    first.join(timeout=2)

    try:
        assert len(results) == 2
        assert sum(result.success for result in results) == 1
        assert {result.error_kind for result in results} == {
            None,
            "shell_capacity_exceeded",
        }
    finally:
        for result in results:
            if result.success:
                manager.terminate("session-a", result.shell_id)


@pytest.mark.skipif(os.name != "posix", reason="requires POSIX process groups")
def test_terminate_kills_descendant_process_group(tmp_path: Path) -> None:
    manager = ShellSessionManager(max_sessions=8, output_max_chars=1024)
    command = (
        "python3 -c \"import subprocess,time; "
        "child=subprocess.Popen(['sleep','30']); "
        "print(child.pid, flush=True); time.sleep(30)\""
    )
    started = manager.start(_request(tmp_path, command))
    output = _wait_for_output(manager, "session-a", started.shell_id)
    child_pid = int(output.output.strip().splitlines()[-1])

    manager.terminate("session-a", started.shell_id)

    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.02)
    else:
        os.kill(child_pid, signal.SIGKILL)
        pytest.fail("descendant process remained alive after shell termination")

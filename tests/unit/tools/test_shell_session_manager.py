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

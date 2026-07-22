from __future__ import annotations

from collections.abc import Callable
import os
from pathlib import Path
import signal
import subprocess
from threading import Event, Lock, Thread, Timer
import time

import pytest

from mycli.domain.runtime import (
    PowerShellEdition,
    ShellKind,
    ShellLifecycleEvent,
    ShellProfile,
)
from mycli.domain.runtime.task_notifications import TaskNotification
from mycli.tools.process_controller import ProcessTerminationOutcome
from mycli.tools.shell_resolver import ShellCommandConfig, ShellResolutionError
from mycli.tools.shell_session_manager import ShellSessionManager, ShellStartRequest
from mycli.tools.shell_transport import ShellTransportRequest
from tests.support.shell_commands import python_shell_command
from tests.support.shell_transports import FakeShellTransport


def _request(
    tmp_path: Path,
    command: str,
    *,
    owner: str = "session-a",
    timeout_seconds: int = 30,
    background: bool | None = True,
    tty: bool = False,
    yield_time_ms: int = 10_000,
    lifecycle_sink: Callable[[ShellLifecycleEvent], None] | None = None,
) -> ShellStartRequest:
    return ShellStartRequest(
        owner_session_id=owner,
        command=command,
        cwd=tmp_path,
        timeout_seconds=timeout_seconds,
        background=background,
        tty=tty,
        yield_time_ms=yield_time_ms,
        lifecycle_sink=lifecycle_sink,
    )


def test_manager_decodes_partial_binary_chunks_without_line_wait(tmp_path: Path) -> None:
    transport = FakeShellTransport()
    transport.publish(b"rea")
    transport.publish(b"dy")
    transport.finish(0)
    manager = ShellSessionManager(transport_factory=lambda _request: transport)

    snapshot = manager.start(_request(tmp_path, "ignored", background=False))

    assert snapshot.output == "ready"
    assert snapshot.stdout == "ready"
    assert snapshot.stderr == ""
    assert snapshot.transport == "pipe"
    assert snapshot.tty is False


def test_manager_flushes_decoder_before_completed_event(tmp_path: Path) -> None:
    events: list[ShellLifecycleEvent] = []
    transport = FakeShellTransport()
    transport.publish(b"\xe4")
    transport.finish(0)
    manager = ShellSessionManager(
        transport_factory=lambda _request: transport,
        output_event_interval_seconds=0,
    )

    snapshot = manager.start(
        _request(
            tmp_path,
            "ignored",
            background=False,
            lifecycle_sink=events.append,
        )
    )

    assert snapshot.output == "\ufffd"
    assert snapshot.decode_replacement_count == 1
    assert [event.kind for event in events][-1] == "shell.completed"
    assert any(
        event.kind == "shell.output" and "\ufffd" in event.output_delta
        for event in events
    )


def test_terminate_owner_tree_uses_colon_delimited_child_boundary(
    tmp_path: Path,
) -> None:
    transports = [FakeShellTransport() for _index in range(4)]
    pending = iter(transports)
    manager = ShellSessionManager(transport_factory=lambda _request: next(pending))
    owners = (
        "main-session",
        "main-session:dream:turn_1:abcd1234",
        "main-session:sub:turn_2:efgh5678",
        "main-session-peer",
    )
    sessions = tuple(
        manager.start(_request(tmp_path, "ignored", owner=owner)) for owner in owners
    )

    terminated = manager.terminate_owner_tree("main-session")

    assert {snapshot.shell_id for snapshot in terminated} == {
        session.shell_id for session in sessions[:3]
    }
    assert all(transport.poll() is not None for transport in transports[:3])
    assert transports[3].poll() is None
    manager.terminate(owners[3], sessions[3].shell_id)


def test_new_session_yields_to_background_after_deadline(tmp_path: Path) -> None:
    transport = FakeShellTransport()
    events: list[ShellLifecycleEvent] = []
    manager = ShellSessionManager(transport_factory=lambda _request: transport)

    snapshot = manager.start(
        _request(
            tmp_path,
            "ignored",
            background=None,
            yield_time_ms=25,
            lifecycle_sink=events.append,
        )
    )

    assert snapshot.background is True
    assert snapshot.process_state == "running_background"
    assert snapshot.yielded is True
    yielded_event = next(
        event
        for event in events
        if event.kind == "shell.list.updated" and event.active_background_count == 1
    )
    assert yielded_event.transport == "pipe"
    assert yielded_event.tty is False
    assert yielded_event.yielded is True
    transport.finish(0)


def test_completion_wins_race_with_yield(tmp_path: Path) -> None:
    transport = FakeShellTransport()
    manager = ShellSessionManager(transport_factory=lambda _request: transport)
    timer = Timer(0.01, lambda: transport.finish(0))
    timer.start()

    snapshot = manager.start(
        _request(tmp_path, "ignored", background=None, yield_time_ms=25)
    )
    timer.join(timeout=1)

    assert snapshot.terminal_state == "completed"
    assert snapshot.background is False
    assert snapshot.yielded is False


def test_new_session_notifies_only_after_it_yields(tmp_path: Path) -> None:
    notifications: list[TaskNotification] = []
    transport = FakeShellTransport()
    transport.finish(0)
    manager = ShellSessionManager(transport_factory=lambda _request: transport)

    snapshot = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="ignored",
            cwd=tmp_path,
            timeout_seconds=30,
            background=None,
            yield_time_ms=250,
            notification_sink=notifications.append,
        )
    )

    assert snapshot.terminal_state == "completed"
    assert notifications == []


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


def test_manager_builds_transport_request_from_resolved_shell(tmp_path: Path) -> None:
    captured: list[ShellTransportRequest] = []

    def failing_factory(request: ShellTransportRequest):
        captured.append(request)
        raise OSError("stop after capture")

    manager = ShellSessionManager(
        shell_resolver=lambda _path: ShellCommandConfig(Path("/custom/bash")),
        transport_factory=failing_factory,
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
    request = captured[0]
    assert request.argv == ("/custom/bash", "-c", "printf ok")
    assert request.cwd == tmp_path
    assert request.tty is False


@pytest.mark.parametrize(
    ("profile", "expected"),
    [
        (
            ShellProfile(ShellKind.BASH, Path("/bin/bash")),
            ["/bin/bash", "-c", "printf ok"],
        ),
        (
            ShellProfile(
                ShellKind.POWERSHELL,
                Path("pwsh.exe"),
                PowerShellEdition.CORE,
            ),
            [
                "pwsh.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "printf ok",
            ],
        ),
        (
            ShellProfile(
                ShellKind.POWERSHELL,
                Path("powershell.exe"),
                PowerShellEdition.DESKTOP,
            ),
            [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "printf ok",
            ],
        ),
        (
            ShellProfile(ShellKind.CMD, Path("cmd.exe")),
            ["cmd.exe", "/d", "/s", "/c", "printf ok"],
        ),
    ],
)
def test_manager_spawns_profile_derived_argv(
    tmp_path: Path,
    profile: ShellProfile,
    expected: list[str],
) -> None:
    captured: list[ShellTransportRequest] = []

    def failing_factory(request: ShellTransportRequest):
        captured.append(request)
        raise OSError("stop after capture")

    manager = ShellSessionManager(transport_factory=failing_factory)
    result = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="printf ok",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            shell_profile=profile,
        )
    )

    assert result.error_kind == "shell_spawn_failed"
    assert [request.argv for request in captured] == [tuple(expected)]


def test_manager_does_not_register_failed_shell_resolution(tmp_path: Path) -> None:
    def missing_shell(_path: str | None) -> ShellCommandConfig:
        raise ShellResolutionError("Install Git for Windows")

    manager = ShellSessionManager(shell_resolver=missing_shell)

    result = manager.start(_request(tmp_path, "printf ok"))

    assert result.error_kind == "shell_resolution_failed"
    assert "Install Git for Windows" in str(result.error)
    assert manager.list_sessions("session-a") == ()


def test_manager_uses_transport_termination_result(tmp_path: Path) -> None:
    class ControlledTransport(FakeShellTransport):
        def terminate(self) -> ProcessTerminationOutcome:
            self.finish(143)
            return ProcessTerminationOutcome("controller_terminated", terminal=True)

    transport = ControlledTransport()
    manager = ShellSessionManager(transport_factory=lambda _request: transport)
    started = manager.start(_request(tmp_path, "sleep 30"))

    snapshot = manager.terminate("session-a", started.shell_id)

    assert snapshot.cleanup_result == "controller_terminated"


def test_manager_keeps_running_state_when_process_termination_fails(
    tmp_path: Path,
) -> None:
    class FailingTransport(FakeShellTransport):
        def terminate(self) -> ProcessTerminationOutcome:
            return ProcessTerminationOutcome(
                "taskkill_failed",
                terminal=False,
                error="access denied",
            )

    transport = FailingTransport()
    manager = ShellSessionManager(transport_factory=lambda _request: transport)
    started = manager.start(_request(tmp_path, "sleep 30"))

    snapshot = manager.terminate("session-a", started.shell_id)

    assert snapshot.status == "running"
    assert snapshot.terminal_state is None
    assert snapshot.cleanup_result == "taskkill_failed"
    transport.finish(0)


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
        transport="windows_conpty",
        tty=True,
        yielded=True,
        shell_kind="powershell",
        shell_edition="core",
    )

    payload = event.to_tui_payload()

    assert payload["shell_id"] == "shell-1"
    assert payload["call_id"] == "call-1"
    assert payload["sequence"] == 1
    assert payload["command_preview"] == "python3 -m http.server"
    assert payload["transport"] == "windows_conpty"
    assert payload["tty"] is True
    assert payload["yielded"] is True
    assert payload["shell_kind"] == "powershell"
    assert payload["shell_edition"] == "core"
    assert "shell_path" not in payload
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
            command=python_shell_command("print('x' * 200)"),
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
            python_shell_command("import time; time.sleep(30)"),
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
        _request(tmp_path, python_shell_command("print('x' * 500)"))
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
            command=python_shell_command(
                "import sys; print('out'); sys.stderr.write('err\\n'); sys.exit(7)"
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
    command = python_shell_command(
        "import subprocess,time; child=subprocess.Popen(['sleep','30']); "
        "print(child.pid, flush=True); time.sleep(30)"
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

from __future__ import annotations

import signal

from mycli.tools.process_controller import (
    WINDOWS_CREATE_NEW_PROCESS_GROUP,
    WINDOWS_CTRL_BREAK_EVENT,
    process_spawn_options,
    terminate_process_tree,
)


class FakeProcess:
    def __init__(self, *, pid: int, polls: list[int | None]) -> None:
        self.pid = pid
        self._polls = iter(polls)
        self._last_poll: int | None = None
        self.sent_signals: list[int] = []
        self.terminate_calls = 0

    def poll(self) -> int | None:
        try:
            self._last_poll = next(self._polls)
        except StopIteration:
            pass
        return self._last_poll

    def send_signal(self, value: int) -> None:
        self.sent_signals.append(value)

    def terminate(self) -> None:
        self.terminate_calls += 1


def test_unix_spawn_options_create_a_new_session() -> None:
    assert process_spawn_options(platform_name="linux") == {"start_new_session": True}


def test_windows_spawn_options_create_a_new_process_group() -> None:
    options = process_spawn_options(platform_name="win32")

    assert int(options["creationflags"]) & WINDOWS_CREATE_NEW_PROCESS_GROUP
    assert "start_new_session" not in options


def test_windows_termination_uses_ctrl_break_then_taskkill() -> None:
    process = FakeProcess(pid=1234, polls=[None, None, None, 1])
    commands: list[list[str]] = []

    outcome = terminate_process_tree(
        process,
        prefer_interrupt=True,
        platform_name="win32",
        wait_for_exit=lambda _process, _timeout: False,
        taskkill=lambda command: commands.append(command),
    )

    assert process.sent_signals == [WINDOWS_CTRL_BREAK_EVENT]
    assert process.terminate_calls == 1
    assert commands == [["taskkill", "/PID", "1234", "/T", "/F"]]
    assert outcome.cleanup_result == "taskkill_tree"
    assert outcome.terminal is True


def test_windows_reports_failed_termination_without_claiming_terminal() -> None:
    process = FakeProcess(pid=1234, polls=[None, None, None, None])

    outcome = terminate_process_tree(
        process,
        prefer_interrupt=False,
        platform_name="win32",
        wait_for_exit=lambda _process, _timeout: False,
        taskkill=lambda _command: (_ for _ in ()).throw(OSError("taskkill failed")),
    )

    assert outcome.cleanup_result == "taskkill_failed"
    assert outcome.terminal is False
    assert outcome.error == "taskkill failed"


def test_unix_termination_targets_process_group() -> None:
    sent: list[tuple[int, int]] = []
    process = FakeProcess(pid=44, polls=[None, None, 0])

    outcome = terminate_process_tree(
        process,
        prefer_interrupt=True,
        platform_name="linux",
        killpg=lambda pid, sig: sent.append((pid, sig)),
        wait_for_exit=lambda _process, _timeout: True,
    )

    assert sent == [(44, signal.SIGINT)]
    assert outcome.cleanup_result == "sent_sigint"
    assert outcome.terminal is True


def test_unix_permission_failure_escalates_to_next_signal() -> None:
    sent: list[int] = []
    process = FakeProcess(pid=44, polls=[None, None, None, 0])

    def killpg(_pid: int, sig: int) -> None:
        sent.append(sig)
        if sig == signal.SIGINT:
            raise PermissionError("denied")

    outcome = terminate_process_tree(
        process,
        prefer_interrupt=True,
        platform_name="linux",
        killpg=killpg,
        wait_for_exit=lambda _process, _timeout: True,
    )

    assert sent == [signal.SIGINT, signal.SIGTERM]
    assert outcome.cleanup_result == "sent_sigterm"
    assert outcome.terminal is True


def test_termination_returns_already_exited_without_signals() -> None:
    process = FakeProcess(pid=44, polls=[0])

    outcome = terminate_process_tree(
        process,
        prefer_interrupt=True,
        platform_name="linux",
    )

    assert outcome.cleanup_result == "already_exited"
    assert outcome.terminal is True

from threading import Event
from time import monotonic

from mycli.domain.runtime import RuntimeInterruptToken


def test_interrupt_token_runs_callbacks_when_requested() -> None:
    token = RuntimeInterruptToken(source="test")
    calls: list[str] = []

    token.add_callback(lambda: calls.append("first"))
    token.request("user_interrupt")

    assert token.interrupted is True
    assert token.reason == "user_interrupt"
    assert calls == ["first"]


def test_interrupt_token_runs_late_callbacks_immediately() -> None:
    token = RuntimeInterruptToken(source="test")
    calls: list[str] = []

    token.request()
    token.add_callback(lambda: calls.append("late"))

    assert calls == ["late"]


def test_interrupt_token_ignores_callback_failures() -> None:
    token = RuntimeInterruptToken(source="test")
    calls: list[str] = []

    def fail() -> None:
        raise RuntimeError("callback failed")

    token.add_callback(fail)
    token.add_callback(lambda: calls.append("after"))
    token.request()

    assert calls == ["after"]


def test_interrupt_token_callback_can_be_unregistered() -> None:
    token = RuntimeInterruptToken(source="test")
    calls: list[str] = []

    unregister = token.add_callback(lambda: calls.append("stale"))
    unregister()
    token.request("user_interrupt")

    assert calls == []


def test_interrupt_token_nonblocking_request_does_not_wait_for_cleanup() -> None:
    token = RuntimeInterruptToken(source="test")
    cleanup_started = Event()
    release_cleanup = Event()

    def blocking_cleanup() -> None:
        cleanup_started.set()
        release_cleanup.wait(timeout=2.0)

    token.add_callback(blocking_cleanup)

    started_at = monotonic()
    token.request_nonblocking("user_interrupt")
    elapsed = monotonic() - started_at

    assert token.interrupted is True
    assert token.reason == "user_interrupt"
    assert elapsed < 0.05
    assert cleanup_started.wait(timeout=1.0)
    release_cleanup.set()


def test_interrupt_token_nonblocking_request_starts_all_cleanups_independently() -> None:
    token = RuntimeInterruptToken(source="test")
    first_started = Event()
    second_started = Event()
    release_first = Event()

    def blocking_first_cleanup() -> None:
        first_started.set()
        release_first.wait(timeout=2.0)

    token.add_callback(blocking_first_cleanup)
    token.add_callback(second_started.set)

    token.request_nonblocking("user_interrupt")

    assert first_started.wait(timeout=1.0)
    assert second_started.wait(timeout=0.05)
    release_first.set()


def test_interrupt_token_records_output_free_user_input_rollback_request() -> None:
    token = RuntimeInterruptToken(source="test")

    token.request_nonblocking(
        "user_interrupt",
        rollback_user_input=True,
    )

    assert token.rollback_user_input is True

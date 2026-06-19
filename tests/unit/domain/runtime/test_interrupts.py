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

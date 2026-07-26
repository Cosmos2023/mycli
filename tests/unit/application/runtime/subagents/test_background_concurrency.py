from __future__ import annotations

import threading
import time
from contextlib import suppress

from mycli.application.runtime.subagents.loop import RuntimeChildTurnRequester
from mycli.domain.runtime import ModelTurnResult, RuntimeInterruptToken


class FakeConcurrentRequester:
    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0
        self.entered = threading.Barrier(2)
        self.release = threading.Event()

    def request_model_turn(
        self,
        *,
        runtime_items,
        legacy_messages,
        tools,
        stream_sink=None,
        interrupt_token=None,
    ):
        del runtime_items, legacy_messages, tools, stream_sink, interrupt_token
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        with suppress(threading.BrokenBarrierError):
            self.entered.wait(timeout=1)
        self.release.wait(timeout=1)
        self.active -= 1
        return ModelTurnResult(items=(), done=True), ()


def test_model_request_lock_serializes_concurrent_calls() -> None:
    requester = FakeConcurrentRequester()
    lock = threading.Lock()
    child_requester = RuntimeChildTurnRequester(
        requester=requester,
        tool_exposure_builder=lambda _: None,
        tool_renderer=lambda _: [],
        model_request_lock=lock,
    )

    def call_child() -> None:
        child_requester.request_child_turn(
            messages=[{"role": "user", "content": "hello"}],
            tool_names=(),
            child_session_id="demo:sub:turn_1:abcd",
        )

    first = threading.Thread(target=call_child)
    second = threading.Thread(target=call_child)
    first.start()
    second.start()
    requester.release.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert requester.max_active == 1


def test_model_request_lock_wait_is_interruptible() -> None:
    requester = FakeConcurrentRequester()
    lock = threading.Lock()
    lock.acquire()
    token = RuntimeInterruptToken(source="subagent")
    child_requester = RuntimeChildTurnRequester(
        requester=requester,
        tool_exposure_builder=lambda _: None,
        tool_renderer=lambda _: [],
        model_request_lock=lock,
    )
    finished = threading.Event()

    def call_child() -> None:
        try:
            child_requester.request_child_turn(
                messages=[{"role": "user", "content": "hello"}],
                tool_names=(),
                child_session_id="demo:sub:turn_1:abcd",
                interrupt_token=token,
            )
        except KeyboardInterrupt:
            finished.set()

    worker = threading.Thread(target=call_child)
    worker.start()
    time.sleep(0.05)
    token.request("subagent_cancelled")
    try:
        assert finished.wait(timeout=0.5)
    finally:
        lock.release()
        worker.join(timeout=1)

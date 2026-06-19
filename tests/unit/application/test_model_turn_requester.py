from __future__ import annotations

from mycli.application.runtime.model.model_turn_requester import ModelTurnRequester
import pytest
import threading

from mycli.domain.runtime import ModelTurnResult, RuntimeBlock, RuntimeInterruptToken
from mycli.llms.clients.openai_chat import ModelResponseError


class StreamingAdapter:
    def stream_turn(self, *, items, tools):
        del items, tools
        yield {"type": "reasoning", "text": "thinking"}
        yield {"type": "text_delta", "text": "hello "}
        yield {
            "type": "tool_call",
            "block": RuntimeBlock(
                type="tool_call",
                tool_name="Read",
                tool_arguments={"file_path": "README.md"},
                call_id="call_1",
            ),
        }
        yield {
            "type": "completed",
            "response_id": "resp_1",
            "metadata": {"usage": {"input_tokens": 10}},
        }


class SinkFailureAdapter:
    def stream_turn(self, *, items, tools):
        del items, tools
        yield {"type": "text_delta", "text": "hello"}
        yield {"type": "completed", "response_id": "resp_1", "metadata": {}}


class MalformedStreamAdapter:
    def stream_turn(self, *, items, tools):
        del items, tools
        yield "not a dict"


class NonStreamingAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        return ModelTurnResult(items=(), done=True)


class InterruptibleStreamingAdapter:
    def __init__(self) -> None:
        self.events_consumed = 0

    def stream_turn(self, *, items, tools):
        del items, tools
        self.events_consumed += 1
        yield {"type": "text_delta", "text": "before"}
        self.events_consumed += 1
        yield {"type": "text_delta", "text": "after"}


class CloseAwareStreamingAdapter:
    def __init__(self) -> None:
        self.seen_token: RuntimeInterruptToken | None = None
        self.used_interruptible_stream = False

    def stream_turn(self, *, items, tools):  # pragma: no cover - should not be used
        del items, tools
        raise AssertionError("stream_turn should not be used when interruptible stream exists")

    def stream_turn_with_interrupt(self, *, items, tools, interrupt_token):
        del items, tools
        self.seen_token = interrupt_token
        self.used_interruptible_stream = True
        yield {"type": "text_delta", "text": "hello"}
        yield {"type": "completed", "response_id": "resp_1", "metadata": {}}


class BlockingInterruptibleStreamingAdapter:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def stream_turn_with_interrupt(self, *, items, tools, interrupt_token):
        del items, tools, interrupt_token
        self.started.set()
        self.release.wait(timeout=30)
        yield {"type": "text_delta", "text": "late"}


def _requester(adapter: object, diagnostics_sink=None) -> ModelTurnRequester:
    return ModelTurnRequester(
        model_adapter=adapter,  # type: ignore[arg-type]
        normalize_tool_call=lambda call: call,
        stream_diagnostics_sink=diagnostics_sink,
    )


def test_model_turn_requester_notifies_stream_sink_in_order() -> None:
    events = []
    diagnostics = []

    result, chunks = _requester(StreamingAdapter(), diagnostics.append).request_model_turn(
        runtime_items=[],
        legacy_messages=[],
        tools=[],
        stream_sink=events.append,
    )

    assert chunks == ("hello ",)
    assert result.response_id == "resp_1"
    assert [event.kind for event in events] == [
        "reasoning",
        "text_delta",
        "tool_call",
        "completed",
    ]
    assert events[0].text == "thinking"
    assert events[1].text == "hello "
    assert events[2].tool_name == "Read"
    assert events[2].metadata == {"arguments": {"file_path": "README.md"}}
    assert events[3].metadata == {"usage": {"input_tokens": 10}}
    assert len(diagnostics) == 1
    assert diagnostics[0].success is True
    assert diagnostics[0].ttfb_ms is not None
    assert diagnostics[0].elapsed_ms >= diagnostics[0].ttfb_ms
    assert diagnostics[0].provider_event_count == 4
    assert diagnostics[0].text_event_count == 1
    assert diagnostics[0].tool_call_event_count == 1
    assert diagnostics[0].completed_event_count == 1
    assert diagnostics[0].text_bytes == len("hello ".encode("utf-8"))
    assert diagnostics[0].failure_kind is None


def test_model_turn_requester_ignores_stream_sink_failures() -> None:
    def failing_sink(_event):
        raise RuntimeError("display failed")

    result, chunks = _requester(SinkFailureAdapter()).request_model_turn(
        runtime_items=[],
        legacy_messages=[],
        tools=[],
        stream_sink=failing_sink,
    )

    assert chunks == ("hello",)
    assert result.response_id == "resp_1"


def test_model_turn_requester_emits_diagnostics_for_malformed_stream_event() -> None:
    diagnostics = []

    with pytest.raises(ModelResponseError, match="must yield dict events"):
        _requester(MalformedStreamAdapter(), diagnostics.append).request_model_turn(
            runtime_items=[],
            legacy_messages=[],
            tools=[],
        )

    assert len(diagnostics) == 1
    assert diagnostics[0].success is False
    assert diagnostics[0].provider_event_count == 1
    assert diagnostics[0].failure_kind == "invalid_stream_event_shape"
    assert "must yield dict events" in diagnostics[0].failure_message


def test_model_turn_requester_ignores_diagnostics_sink_failures() -> None:
    def failing_diagnostics_sink(_diagnostics):
        raise RuntimeError("diagnostics failed")

    result, chunks = _requester(SinkFailureAdapter(), failing_diagnostics_sink).request_model_turn(
        runtime_items=[],
        legacy_messages=[],
        tools=[],
    )

    assert chunks == ("hello",)
    assert result.response_id == "resp_1"


def test_model_turn_requester_does_not_emit_stream_diagnostics_for_non_streaming_adapter() -> None:
    diagnostics = []

    result, chunks = _requester(NonStreamingAdapter(), diagnostics.append).request_model_turn(
        runtime_items=[],
        legacy_messages=[],
        tools=[],
    )

    assert result.done is True
    assert chunks == ()
    assert diagnostics == []


def test_model_turn_requester_stops_stream_when_interrupt_token_is_requested() -> None:
    adapter = InterruptibleStreamingAdapter()
    token = RuntimeInterruptToken()
    events = []

    def sink(event):
        events.append(event)
        token.request()

    with pytest.raises(KeyboardInterrupt):
        _requester(adapter).request_model_turn(
            runtime_items=[],
            legacy_messages=[],
            tools=[],
            stream_sink=sink,
            interrupt_token=token,
        )

    assert [event.text for event in events] == ["before"]
    assert adapter.events_consumed <= 2


def test_model_turn_requester_prefers_interruptible_stream_adapter() -> None:
    adapter = CloseAwareStreamingAdapter()
    token = RuntimeInterruptToken()

    result, chunks = _requester(adapter).request_model_turn(
        runtime_items=[],
        legacy_messages=[],
        tools=[],
        interrupt_token=token,
    )

    assert result.response_id == "resp_1"
    assert chunks == ("hello",)
    assert adapter.used_interruptible_stream is True
    assert adapter.seen_token is token


def test_model_turn_requester_interrupts_before_first_stream_event() -> None:
    adapter = BlockingInterruptibleStreamingAdapter()
    token = RuntimeInterruptToken()
    result_holder: dict[str, object] = {}

    def request() -> None:
        try:
            _requester(adapter).request_model_turn(
                runtime_items=[],
                legacy_messages=[],
                tools=[],
                interrupt_token=token,
            )
        except BaseException as exc:  # noqa: BLE001 - assert exact type below.
            result_holder["exception"] = exc

    thread = threading.Thread(target=request)
    thread.start()
    assert adapter.started.wait(timeout=1.0)
    token.request()
    thread.join(timeout=0.5)
    try:
        assert not thread.is_alive()
    finally:
        adapter.release.set()
        thread.join(timeout=3.0)

    assert not thread.is_alive()
    assert isinstance(result_holder.get("exception"), KeyboardInterrupt)

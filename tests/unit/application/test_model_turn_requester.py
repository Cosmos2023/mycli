from __future__ import annotations

from mycli.application.runtime.model.model_turn_requester import ModelTurnRequester
import pytest

from mycli.domain.runtime import ModelTurnResult, RuntimeBlock
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

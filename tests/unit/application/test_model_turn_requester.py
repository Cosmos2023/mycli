from __future__ import annotations

from mycli.application.runtime.model.model_turn_requester import ModelTurnRequester
from mycli.domain.runtime import RuntimeBlock


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


def _requester(adapter: object) -> ModelTurnRequester:
    return ModelTurnRequester(
        model_adapter=adapter,  # type: ignore[arg-type]
        normalize_tool_call=lambda call: call,
    )


def test_model_turn_requester_notifies_stream_sink_in_order() -> None:
    events = []

    result, chunks = _requester(StreamingAdapter()).request_model_turn(
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

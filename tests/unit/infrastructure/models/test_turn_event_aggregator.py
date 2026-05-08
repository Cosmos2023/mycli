from __future__ import annotations

from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource
from mycli.llms.adapters.turn_event_aggregator import TurnEventAggregator


def test_turn_event_aggregator_builds_model_turn_result_from_mixed_events() -> None:
    aggregator = TurnEventAggregator()

    result = aggregator.collect(
        [
            ModelEvent(type=ModelEventType.REASONING_DELTA, text="Inspecting tool options"),
            ModelEvent.message_delta(text="I will inspect the repository."),
            ModelEvent.tool_call_requested(
                tool_name="list_directory",
                tool_arguments={"path": "."},
                call_id="call_001",
                source=ToolExecutionSource.NATIVE,
                provider_id="fc_001",
            ),
            ModelEvent(type=ModelEventType.TURN_COMPLETED, response_id="resp_123"),
        ]
    )

    assert result.response_id == "resp_123"
    assert result.done is False
    assert result.items[0].blocks[0].type == "reasoning"
    assert result.items[0].blocks[1].type == "text"
    assert result.items[0].blocks[2].type == "tool_call"
    assert result.items[0].blocks[2].source == "native"


def test_turn_event_aggregator_marks_turn_done_when_no_tool_call_requested() -> None:
    aggregator = TurnEventAggregator()

    result = aggregator.collect(
        [
            ModelEvent.message_delta(text="Done."),
            ModelEvent(type=ModelEventType.TURN_COMPLETED, response_id="resp_done"),
        ]
    )

    assert result.done is True
    assert result.items[0].blocks[0].text == "Done."


def test_turn_event_aggregator_preserves_tool_call_metadata() -> None:
    aggregator = TurnEventAggregator()

    result = aggregator.collect(
        [
            ModelEvent.tool_call_requested(
                tool_name="read_file",
                tool_arguments={"path": "mission.txt"},
                call_id="call_read_file_1",
                source=ToolExecutionSource.NATIVE,
                metadata={
                    "deepseek": {
                        "reasoning_content": "I need to inspect the requested file."
                    }
                },
            )
        ]
    )

    tool_block = result.items[0].blocks[0]
    assert tool_block.metadata["deepseek"] == {
        "reasoning_content": "I need to inspect the requested file."
    }

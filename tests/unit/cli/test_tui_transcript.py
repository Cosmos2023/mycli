from __future__ import annotations

from mycli.cli.tui.transcript import (
    TuiTranscriptKind,
    append_final_answer,
    execution_status_label,
    items_from_response,
    phase_for_tool,
    summarize_tool_activity,
)
from mycli.domain.runtime import (
    ActivityEvent,
    RuntimeStreamEvent,
    StopReason,
    TurnItem,
    TurnItemType,
    TurnRecord,
    TurnResponse,
    TurnStatus,
)


def test_items_from_response_omits_visible_role_labels() -> None:
    response = TurnResponse(
        assistant_message="Final answer",
        activity_events=(ActivityEvent(kind="thinking", message="Thinking: inspect repo"),),
    )

    items = items_from_response(response)

    assert [item.kind for item in items] == [
        TuiTranscriptKind.THINKING,
        TuiTranscriptKind.ASSISTANT,
    ]
    assert all("ASSISTANT" not in item.text and "USER" not in item.text for item in items)


def test_items_from_turn_record_folds_diff_output() -> None:
    diff = "\n".join(f"+line {index}" for index in range(1, 8))
    response = TurnResponse(
        assistant_message="done",
        turn=TurnRecord(
            thread_id="demo",
            turn_id="turn_1",
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.ASSISTANT_COMPLETED,
            started_at="2026-05-26T00:00:00Z",
            completed_at="2026-05-26T00:00:01Z",
            items=(
                TurnItem(
                    type=TurnItemType.TOOL_RESULT,
                    text="Edited file",
                    tool_name="Edit",
                    metadata={"diff": diff},
                ),
            ),
        ),
    )

    items = items_from_response(response, diff_max_lines=2)

    assert any(item.kind is TuiTranscriptKind.DIFF for item in items)
    assert "[diff] ... 5 lines omitted" in [item.text for item in items]


def test_summarize_tool_activity_folds_many_reads() -> None:
    events = tuple(
        RuntimeStreamEvent(
            kind="tool_call",
            tool_name="Read",
            metadata={"path": f"file_{index}.py"},
        )
        for index in range(6)
    )

    assert summarize_tool_activity(events, max_items=3) == (
        "Read file_0.py",
        "Read file_1.py",
        "Read file_2.py",
        "... 3 more tool calls folded",
    )


def test_execution_status_label_uses_turn_elapsed_seconds() -> None:
    assert execution_status_label(phase="running_tests", elapsed_seconds=37.4) == (
        "Running tests... (37s)"
    )
    assert execution_status_label(phase="thinking", elapsed_seconds=3.2) == "Thinking... (3s)"
    assert execution_status_label(phase="editing", elapsed_seconds=44.2) == (
        "Editing files... (44s)"
    )


def test_phase_for_tool_maps_common_agent_actions() -> None:
    assert phase_for_tool("Read") == "reading"
    assert phase_for_tool("Grep") == "searching"
    assert phase_for_tool("Edit") == "editing"
    assert phase_for_tool("Pytest") == "running_tests"


def test_append_final_answer_replaces_stream_buffer_when_different() -> None:
    items = append_final_answer(
        existing_stream="partial answer",
        final_answer="final answer",
    )

    assert len(items) == 1
    assert items[0].kind is TuiTranscriptKind.ASSISTANT
    assert items[0].text == "final answer"

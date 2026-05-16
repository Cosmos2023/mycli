from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    PlanItem,
    PlanState,
    PlanStatus,
    RuntimeBlock,
    StopReason,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.services.turn_guard import ContinueReason, ExitReason, NoProgressTracker, TurnCheckpoint


def _tool_message(
    *,
    tool_name: str,
    path: str | None,
    success: bool = True,
    text: str | None = None,
) -> Message:
    return Message(
        role="tool",
        content=text or f"Tool {tool_name}",
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text=text or f"Tool {tool_name}",
                metadata={
                    "tool_name": tool_name,
                    "success": success,
                    "path": path,
                },
            ),
        ),
    )


def _assistant_tool_call(
    *,
    name: str,
    arguments: dict[str, object],
) -> Message:
    return Message(
        role="assistant",
        content="",
        tool_calls=(
            ToolCall(
                name=name,
                arguments=arguments,
                reason="explore",
                call_id=f"call_{name}",
            ),
        ),
    )


def _conversation(*messages: Message) -> Conversation:
    return Conversation(
        session_id="test",
        messages=[
            Message(role="user", content="current task"),
            *messages,
        ],
    )


def test_current_window_budget_exceeded_requests_compaction_without_hard_stop() -> None:
    checkpoint = TurnCheckpoint(max_tokens_per_turn=1000)

    result = checkpoint.evaluate(
        step_index=0,
        conversation=_conversation(),
        current_window_tokens=1001,
    )

    assert result.exit_reason is None
    assert result.stop_reason is None
    assert result.continue_reason == ContinueReason.COMPACT_CONTEXT
    assert any("compact" in reminder.lower() for reminder in result.reminders)


def test_current_window_budget_at_limit_requests_compaction_not_hard_stop() -> None:
    checkpoint = TurnCheckpoint(max_tokens_per_turn=1000)

    result = checkpoint.evaluate(
        step_index=0,
        conversation=_conversation(),
        current_window_tokens=1000,
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.COMPACT_CONTEXT
    assert any("Compact context" in reminder for reminder in result.reminders)


def test_cumulative_prompt_tokens_are_not_a_checkpoint_input() -> None:
    checkpoint = TurnCheckpoint(max_tokens_per_turn=1000)

    result = checkpoint.evaluate(
        step_index=3,
        conversation=_conversation(),
        current_window_tokens=700,
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.NEXT_STEP


def test_tool_count_exceeded_warns_without_hard_stop() -> None:
    checkpoint = TurnCheckpoint(max_tool_calls_per_turn=5)

    result = checkpoint.evaluate(
        step_index=6,
        conversation=_conversation(),
    )

    assert result.exit_reason is None
    assert result.stop_reason is None
    assert result.continue_reason == ContinueReason.FORCE_ANSWER
    assert any("maximum tool call limit" in reminder for reminder in result.reminders)


def test_tool_count_at_limit_gives_force_answer_not_hard_stop() -> None:
    checkpoint = TurnCheckpoint(max_tool_calls_per_turn=5)

    result = checkpoint.evaluate(
        step_index=5,
        conversation=_conversation(),
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.FORCE_ANSWER
    assert any("MUST answer" in reminder for reminder in result.reminders)


def test_loop_detected_when_same_tool_call_repeated_4_times() -> None:
    checkpoint = TurnCheckpoint(max_same_tool_calls=4)
    repeated = _assistant_tool_call(name="list_directory", arguments={"path": "."})
    conversation = _conversation(repeated, repeated, repeated, repeated)

    result = checkpoint.evaluate(
        step_index=3,
        conversation=conversation,
    )

    assert result.exit_reason == ExitReason.LOOP_DETECTED
    assert result.stop_reason == StopReason.LOOP_DETECTED


def test_loop_detector_is_current_turn_scoped() -> None:
    checkpoint = TurnCheckpoint(max_same_tool_calls=4)
    repeated = _assistant_tool_call(name="list_directory", arguments={"path": "."})
    conversation = Conversation(
        session_id="test",
        messages=[
            Message(role="user", content="old"),
            repeated,
            repeated,
            repeated,
            repeated,
            Message(role="user", content="new"),
        ],
    )

    result = checkpoint.evaluate(step_index=0, conversation=conversation)

    assert result.exit_reason is None


def test_repeated_replanning_stops_when_plan_exists() -> None:
    checkpoint = TurnCheckpoint(repeated_replanning_threshold=2)
    conversation = _conversation(
        _assistant_tool_call(
            name="update_plan",
            arguments={"items": [{"content": "step 1", "status": "in_progress"}]},
        ),
        _assistant_tool_call(
            name="update_plan",
            arguments={"items": [{"content": "step 1 revised", "status": "in_progress"}]},
        ),
    )
    plan_state = PlanState(
        items=(PlanItem(id="1", content="step 1", status=PlanStatus.IN_PROGRESS),)
    )

    result = checkpoint.evaluate(
        step_index=2,
        conversation=conversation,
        plan_state=plan_state,
    )

    assert result.exit_reason == ExitReason.REPEATED_REPLANNING
    assert result.stop_reason == StopReason.LOOP_DETECTED


def test_repeated_replanning_does_not_stop_without_existing_plan() -> None:
    checkpoint = TurnCheckpoint(repeated_replanning_threshold=2)
    conversation = _conversation(
        _assistant_tool_call(name="update_plan", arguments={"items": []}),
        _assistant_tool_call(name="update_plan", arguments={"items": []}),
    )

    result = checkpoint.evaluate(
        step_index=2,
        conversation=conversation,
    )

    assert result.exit_reason is None


def test_no_progress_stops_after_threshold() -> None:
    checkpoint = TurnCheckpoint(no_progress_threshold=3)
    conversation = _conversation(
        _assistant_tool_call(name="list_directory", arguments={"path": "."}),
    )
    tracker = NoProgressTracker()
    tracker.update(conversation)
    tracker.update(conversation)
    tracker.update(conversation)
    tracker.update(conversation)

    result = checkpoint.evaluate(
        step_index=3,
        conversation=conversation,
        no_progress_tracker=tracker,
    )

    assert result.exit_reason == ExitReason.NO_PROGRESS
    assert result.stop_reason == StopReason.LOOP_DETECTED


def test_no_progress_resets_when_new_tool_called() -> None:
    tracker = NoProgressTracker()
    conv1 = _conversation(
        _assistant_tool_call(name="list_directory", arguments={"path": "."}),
    )
    tracker.update(conv1)
    tracker.update(conv1)
    assert tracker.no_progress_count() == 1

    conv2 = _conversation(
        _assistant_tool_call(name="list_directory", arguments={"path": "."}),
        _assistant_tool_call(name="read_file", arguments={"path": "a.py"}),
    )
    tracker.update(conv2)
    assert tracker.no_progress_count() == 0


def test_force_answer_when_step_exceeds_threshold() -> None:
    checkpoint = TurnCheckpoint(force_answer_threshold=12)

    result = checkpoint.evaluate(
        step_index=12,
        conversation=_conversation(),
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.FORCE_ANSWER
    assert any("Stop exploring" in reminder for reminder in result.reminders)


def test_reroute_when_repeated_calls_but_below_stop_threshold() -> None:
    checkpoint = TurnCheckpoint(max_same_tool_calls=4, reroute_threshold=3)
    repeated = _assistant_tool_call(name="list_directory", arguments={"path": "."})
    conversation = _conversation(repeated, repeated, repeated)

    result = checkpoint.evaluate(
        step_index=2,
        conversation=conversation,
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.REROUTE
    assert any("different" in reminder.lower() for reminder in result.reminders)


def test_truncation_aware_when_truncation_signal_present() -> None:
    checkpoint = TurnCheckpoint()
    conversation = _conversation(
        _tool_message(
            tool_name="read_file",
            path="src/x.py",
            text="... excerpt truncated; use read_file_range for exact sections if needed.",
        ),
    )

    result = checkpoint.evaluate(
        step_index=0,
        conversation=conversation,
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.TRUNCATION_AWARE
    assert any("read_file_range" in reminder for reminder in result.reminders)


def test_next_step_when_all_conditions_normal() -> None:
    checkpoint = TurnCheckpoint()

    result = checkpoint.evaluate(
        step_index=0,
        conversation=_conversation(),
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.NEXT_STEP
    assert result.reminders == ()


def test_force_answer_beats_reroute_in_priority() -> None:
    checkpoint = TurnCheckpoint(
        force_answer_threshold=10,
        reroute_threshold=3,
        max_same_tool_calls=10,
    )
    repeated = _assistant_tool_call(name="list_directory", arguments={"path": "."})
    conversation = _conversation(repeated, repeated, repeated)

    result = checkpoint.evaluate(
        step_index=11,
        conversation=conversation,
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.FORCE_ANSWER

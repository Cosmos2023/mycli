from __future__ import annotations

import inspect

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    AgentConfig,
    PlanItem,
    PlanState,
    PlanStatus,
    RuntimeBlock,
    StopReason,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.services.turn_guard import ContinueReason, ExitReason, NoProgressTracker, TurnCheckpoint


def test_turn_checkpoint_does_not_expose_force_answer_configuration() -> None:
    parameters = inspect.signature(TurnCheckpoint).parameters
    config_parameters = inspect.signature(AgentConfig).parameters

    assert "max_tool_calls_per_turn" not in parameters
    assert "max_same_tool_calls" not in parameters
    assert "force_answer_threshold" not in parameters
    assert "max_tool_calls_per_turn" not in config_parameters
    assert "max_same_tool_calls" not in config_parameters
    assert "force_answer_threshold" not in config_parameters
    assert "FORCE_ANSWER" not in ContinueReason.__members__


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


def _failed_tool_message(
    *,
    tool_name: str,
    path: str = "",
    error_kind: str,
    command: str | None = None,
) -> Message:
    metadata: dict[str, object] = {
        "tool_name": tool_name,
        "success": False,
        "path": path,
        "error_kind": error_kind,
    }
    if command is not None:
        metadata["raw_payload"] = {"command": command}
    return Message(
        role="tool",
        content=f"Failed to run {tool_name}",
        blocks=(
            RuntimeBlock(
                type="tool_result",
                text=f"Failed to run {tool_name}",
                metadata=metadata,
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


def test_tool_count_exceeded_does_not_force_answer() -> None:
    checkpoint = TurnCheckpoint()

    result = checkpoint.evaluate(
        step_index=6,
        conversation=_conversation(),
    )

    assert result.exit_reason is None
    assert result.stop_reason is None
    assert result.continue_reason == ContinueReason.NEXT_STEP
    assert result.reminders == ()


def test_tool_count_at_limit_does_not_force_answer() -> None:
    checkpoint = TurnCheckpoint()

    result = checkpoint.evaluate(
        step_index=5,
        conversation=_conversation(),
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.NEXT_STEP
    assert result.reminders == ()


def test_repeated_successful_tool_calls_only_request_a_different_path() -> None:
    checkpoint = TurnCheckpoint()
    repeated = _assistant_tool_call(name="LS", arguments={"path": "."})
    conversation = _conversation(repeated, repeated, repeated)

    result = checkpoint.evaluate(
        step_index=3,
        conversation=conversation,
    )

    assert result.exit_reason is None
    assert result.stop_reason is None
    assert result.continue_reason == ContinueReason.REROUTE
    assert any("different" in reminder.lower() for reminder in result.reminders)


def test_repeated_successful_tool_call_reminder_is_emitted_only_at_threshold() -> None:
    checkpoint = TurnCheckpoint()
    repeated = _assistant_tool_call(name="LS", arguments={"path": "."})

    result = checkpoint.evaluate(
        step_index=4,
        conversation=_conversation(repeated, repeated, repeated, repeated),
    )

    assert result.exit_reason is None
    assert result.stop_reason is None
    assert result.reminders == ()


def test_repeated_failed_tool_results_request_reroute_without_stopping() -> None:
    checkpoint = TurnCheckpoint(repeated_failed_tool_threshold=3)
    failed_read = _failed_tool_message(
        tool_name="Read",
        path="missing.py",
        error_kind="not_found",
    )

    result = checkpoint.evaluate(
        step_index=3,
        conversation=_conversation(failed_read, failed_read, failed_read),
    )

    assert result.exit_reason is None
    assert result.stop_reason is None
    assert result.continue_reason == ContinueReason.REROUTE
    assert any("failed" in reminder.lower() for reminder in result.reminders)
    assert result.diagnostics == {
        "trigger": "repeated_failed_tool_result",
        "count": 3,
        "tool_name": "Read",
        "path": "missing.py",
        "error_kind": "not_found",
    }


def test_repeated_failed_tool_result_reminder_is_emitted_only_at_threshold() -> None:
    checkpoint = TurnCheckpoint(repeated_failed_tool_threshold=3)
    failed_read = _failed_tool_message(
        tool_name="Read",
        path="missing.py",
        error_kind="not_found",
    )

    result = checkpoint.evaluate(
        step_index=4,
        conversation=_conversation(failed_read, failed_read, failed_read, failed_read),
    )

    assert result.exit_reason is None
    assert result.stop_reason is None
    assert result.reminders == ()


def test_distinct_failed_shell_commands_do_not_share_a_failure_signature() -> None:
    checkpoint = TurnCheckpoint(repeated_failed_tool_threshold=3)
    failures = tuple(
        _failed_tool_message(
            tool_name="Shell",
            error_kind="nonzero_exit",
            command=command,
        )
        for command in (
            "rg -l 'mcp_servers' .",
            "ls ~/.mycli/mcp_servers.toml",
            "rg -l 'mcp.*serv' .",
        )
    )

    result = checkpoint.evaluate(
        step_index=3,
        conversation=_conversation(*failures),
    )

    assert result.exit_reason is None
    assert result.stop_reason is None
    assert result.reminders == ()


def test_loop_detector_is_current_turn_scoped() -> None:
    checkpoint = TurnCheckpoint()
    repeated = _assistant_tool_call(name="LS", arguments={"path": "."})
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
        _assistant_tool_call(name="LS", arguments={"path": "."}),
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
        _assistant_tool_call(name="LS", arguments={"path": "."}),
    )
    tracker.update(conv1)
    tracker.update(conv1)
    assert tracker.no_progress_count() == 1

    conv2 = _conversation(
        _assistant_tool_call(name="LS", arguments={"path": "."}),
        _assistant_tool_call(name="Read", arguments={"path": "a.py"}),
    )
    tracker.update(conv2)
    assert tracker.no_progress_count() == 0


def test_high_step_count_does_not_disable_tools() -> None:
    checkpoint = TurnCheckpoint()

    result = checkpoint.evaluate(
        step_index=12,
        conversation=_conversation(),
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.NEXT_STEP
    assert result.reminders == ()


def test_reroute_when_repeated_calls_but_below_stop_threshold() -> None:
    checkpoint = TurnCheckpoint(reroute_threshold=3)
    repeated = _assistant_tool_call(name="LS", arguments={"path": "."})
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
            tool_name="Read",
            path="src/x.py",
            text="... excerpt truncated; use Read with offset/limit for exact sections if needed.",
        ),
    )

    result = checkpoint.evaluate(
        step_index=0,
        conversation=conversation,
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.TRUNCATION_AWARE
    assert any("Read with offset/limit" in reminder for reminder in result.reminders)


def test_next_step_when_all_conditions_normal() -> None:
    checkpoint = TurnCheckpoint()

    result = checkpoint.evaluate(
        step_index=0,
        conversation=_conversation(),
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.NEXT_STEP
    assert result.reminders == ()


def test_repeated_calls_remain_an_advisory_after_many_steps() -> None:
    checkpoint = TurnCheckpoint(
        reroute_threshold=3,
    )
    repeated = _assistant_tool_call(name="LS", arguments={"path": "."})
    conversation = _conversation(repeated, repeated, repeated)

    result = checkpoint.evaluate(
        step_index=11,
        conversation=conversation,
    )

    assert result.exit_reason is None
    assert result.continue_reason == ContinueReason.REROUTE

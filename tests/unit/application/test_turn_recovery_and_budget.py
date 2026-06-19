from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from mycli.application.runtime.recovery import (
    ErrorClassifier,
    RecoveryErrorClass,
    RecoveryPolicy,
    RecoveryPolicyAction,
    RetryBackoffPolicy,
)
from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.application.runtime.turn_executor import (
    BudgetNudge,
    LoopState,
    TurnExecutor,
    _apply_l4_recent_file_hints,
    _repair_interrupted_tool_results,
)
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    AgentConfig,
    ModelTurnResult,
    PlanState,
    RuntimeBlock,
    RuntimeItem,
    RuntimeStreamEvent,
    StopReason,
    TurnItemType,
    TurnStatus,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.schemas.responses_protocol import ResponsesContinuationState
from mycli.services.context.compaction import ContextBudget


class ContextWindowRetryThenFailAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items, tools):
        del tools
        self.calls += 1
        self.seen_items.append(items)
        raise ModelResponseError(
            f"context window overflow attempt {self.calls}",
            stop_reason=StopReason.CONTEXT_WINDOW_EXCEEDED,
            failure_kind="context_window_exceeded",
        )


class ContextWindowDrainCompactThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items, tools):
        del tools
        self.calls += 1
        self.seen_items.append(items)
        if self.calls <= 2:
            raise ModelResponseError(
                f"context window overflow attempt {self.calls}",
                stop_reason=StopReason.CONTEXT_WINDOW_EXCEEDED,
                failure_kind="context_window_exceeded",
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Recovered after compaction"),),
                ),
            ),
            done=True,
        )


class OutputTokenEscalateThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.output_token_budgets: list[int] = []
        self.seen_items: list[list[RuntimeItem]] = []

    def set_max_output_tokens(self, value: int) -> None:
        self.output_token_budgets.append(value)

    def next_turn(self, *, items, tools):
        del tools
        self.calls += 1
        self.seen_items.append(items)
        if self.calls == 1:
            raise ModelResponseError(
                "output token limit",
                failure_kind="output_token_limit",
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Recovered with more output budget"),),
                ),
            ),
            done=True,
        )


class KeyboardInterruptAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        raise KeyboardInterrupt()


class InterruptOnceThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.seen_items: list[list[RuntimeItem]] = []

    def next_turn(self, *, items, tools):
        del tools
        self.calls += 1
        self.seen_items.append(items)
        if self.calls == 1:
            raise KeyboardInterrupt()
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Resumed after interrupt"),),
                ),
            ),
            done=True,
        )


class RetryTwiceThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        if self.calls <= 2:
            raise ModelResponseError(
                "rate limited",
                stop_reason=StopReason.RATE_LIMITED,
                is_retryable=True,
                failure_kind="rate_limited",
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Recovered after backoff"),),
                ),
            ),
            done=True,
        )


class InvalidEncryptedContentThenDoneAdapter:
    def __init__(self) -> None:
        self.calls = 0
        self.continuation_states: list[object] = []

    def set_continuation_state(self, state: object) -> None:
        self.continuation_states.append(state)

    def get_continuation_state(self) -> object | None:
        return None

    def next_turn(self, *, items, tools):
        del items, tools
        self.calls += 1
        if self.calls == 1:
            raise ModelResponseError(
                "invalid encrypted_content: sk-do-not-print",
                failure_kind="invalid_encrypted_content",
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Recovered without encrypted replay"),),
                ),
            ),
            done=True,
        )


class FallbackModelAdapter:
    def __init__(self) -> None:
        self.model = "primary-model"
        self.models_seen: list[str] = []

    def set_model(self, model: str) -> None:
        self.model = model

    def next_turn(self, *, items, tools):
        del items, tools
        self.models_seen.append(self.model)
        if self.model == "primary-model":
            raise ModelResponseError(
                "provider overloaded",
                stop_reason=StopReason.RATE_LIMITED,
                is_retryable=True,
                failure_kind="provider_overloaded",
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Recovered on fallback model"),),
                ),
            ),
            done=True,
        )


class SlowSuccessfulAdapter:
    def next_turn(self, *, items, tools):
        del items, tools
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Done after silence"),),
                ),
            ),
            done=True,
        )


def _runtime_reminder_text(items: list[RuntimeItem]) -> str:
    return "\n".join(
        block.text or ""
        for item in items
        for block in item.blocks
        if block.type == "text" and isinstance(block.text, str)
    )


def test_budget_nudge_warns_at_60_percent_and_deduplicates() -> None:
    budget = ContextBudget(max_tokens=100)
    budget.record({"total_tokens": 60})

    reminders = BudgetNudge().apply(budget, ())
    duplicate = BudgetNudge().apply(budget, reminders)

    assert len(reminders) == 1
    assert reminders == duplicate
    assert "60%" in reminders[0]


def test_budget_nudge_adds_force_answer_at_85_percent() -> None:
    budget = ContextBudget(max_tokens=100)
    budget.record({"total_tokens": 85})

    reminders = BudgetNudge().apply(budget, ())

    assert len(reminders) == 2
    assert any("60%" in reminder for reminder in reminders)
    assert any("85%" in reminder and "answer" in reminder.lower() for reminder in reminders)


def test_l4_recent_file_hints_are_added_once() -> None:
    metrics: dict[str, int | float | str | list[str]] = {
        "recent_files": ["src/a.py", "src/b.py"]
    }

    reminders = _apply_l4_recent_file_hints((), metrics)
    duplicate = _apply_l4_recent_file_hints(reminders, metrics)

    assert reminders == duplicate
    assert len(reminders) == 1
    assert "src/a.py, src/b.py" in reminders[0]


def test_retry_backoff_policy_calculates_capped_delays() -> None:
    policy = RetryBackoffPolicy(base_seconds=0.25, multiplier=2.0, max_seconds=1.0)

    assert policy.delay_for_attempt(1) == 0.25
    assert policy.delay_for_attempt(2) == 0.5
    assert policy.delay_for_attempt(3) == 1.0
    assert policy.delay_for_attempt(4) == 1.0


def test_error_classifier_maps_p8_provider_error_taxonomy() -> None:
    classifier = ErrorClassifier()

    cases = {
        "invalid_encrypted_content": RecoveryErrorClass.INVALID_ENCRYPTED_CONTENT,
        "context_window_exceeded": RecoveryErrorClass.CONTEXT_OVERFLOW,
        "schema_rejected": RecoveryErrorClass.SCHEMA_REJECTED,
        "unsupported_payload": RecoveryErrorClass.UNSUPPORTED_PAYLOAD,
        "image_too_large": RecoveryErrorClass.IMAGE_TOO_LARGE,
    }

    for failure_kind, expected in cases.items():
        result = classifier.classify(ModelResponseError("provider failed", failure_kind=failure_kind))
        assert result.error_class is expected
        assert result.failure_kind == failure_kind
        assert "provider failed" not in result.to_trace_payload().values()


def test_error_classifier_uses_bounded_message_fallbacks() -> None:
    classifier = ErrorClassifier()

    assert classifier.classify(
        ModelResponseError("invalid encrypted_content replay")
    ).error_class is RecoveryErrorClass.INVALID_ENCRYPTED_CONTENT
    assert classifier.classify(
        ModelResponseError("This model's maximum context length was exceeded")
    ).error_class is RecoveryErrorClass.CONTEXT_OVERFLOW
    assert classifier.classify(
        ModelResponseError("Invalid schema for request payload")
    ).error_class is RecoveryErrorClass.SCHEMA_REJECTED
    assert classifier.classify(
        ModelResponseError("Unsupported content block in request payload")
    ).error_class is RecoveryErrorClass.UNSUPPORTED_PAYLOAD
    assert classifier.classify(
        ModelResponseError("image payload is too large")
    ).error_class is RecoveryErrorClass.IMAGE_TOO_LARGE


def test_recovery_policy_maps_p8_retry_and_surface_actions() -> None:
    policy = RecoveryPolicy()
    classifier = ErrorClassifier()

    invalid = policy.decide(
        classifier.classify(
            ModelResponseError("invalid encrypted_content", failure_kind="invalid_encrypted_content")
        )
    )
    assert invalid.action is RecoveryPolicyAction.STRIP_ENCRYPTED_REASONING_RETRY
    assert invalid.should_retry is True
    assert invalid.max_attempts == 1

    overflow = policy.decide(
        classifier.classify(
            ModelResponseError("context overflow", failure_kind="context_window_exceeded")
        )
    )
    assert overflow.action is RecoveryPolicyAction.COMPACT_OR_SHRINK_RETRY
    assert overflow.should_retry is True

    schema_without_repair = policy.decide(
        classifier.classify(
            ModelResponseError("schema rejected", failure_kind="schema_rejected")
        )
    )
    assert schema_without_repair.action is RecoveryPolicyAction.SURFACE_ONLY
    assert schema_without_repair.should_retry is False

    schema_with_repair = policy.decide(
        classifier.classify(
            ModelResponseError("schema rejected", failure_kind="schema_rejected")
        ),
        deterministic_repair_available=True,
    )
    assert schema_with_repair.action is RecoveryPolicyAction.SANITIZE_REPAIR_RETRY
    assert schema_with_repair.should_retry is True

    unsupported = policy.decide(
        classifier.classify(
            ModelResponseError("unsupported", failure_kind="unsupported_payload")
        )
    )
    image = policy.decide(
        classifier.classify(
            ModelResponseError("image too large", failure_kind="image_too_large")
        )
    )
    assert unsupported.action is RecoveryPolicyAction.SURFACE_ONLY
    assert image.action is RecoveryPolicyAction.SURFACE_ONLY


def test_turn_executor_records_retry_backoff_metadata(tmp_path: Path) -> None:
    sleeps: list[float] = []
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=RetryTwiceThenDoneAdapter(),
    )
    runtime._recovery_sleep = sleeps.append
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        transport_retry_limit=2,
    )

    response = runtime.handle_user_turn("inspect")

    assert response.assistant_message == "Recovered after backoff"
    assert sleeps == [0.25, 0.5]
    assert response.turn is not None
    warnings = [
        item for item in response.turn.items if item.type is TurnItemType.WARNING
    ]
    assert warnings[0].metadata["recovery_kind"] == "retry"
    assert warnings[0].metadata["failure_kind"] == "rate_limited"
    assert warnings[0].metadata["delay_seconds"] == 0.25


def test_turn_executor_retries_invalid_encrypted_content_once_without_leaking_secret(
    tmp_path: Path,
) -> None:
    adapter = InvalidEncryptedContentThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    initial_state = ResponsesContinuationState(
        response_id="resp_prev",
        request_signature="{}",
        request_input=({"type": "reasoning", "encrypted_content": "opaque"},),
        response_output=(),
        eligible=True,
    )
    runtime._session_service.save_responses_continuation_state(
        runtime._config.session_id,
        initial_state,
    )

    response = runtime.handle_user_turn("inspect")
    trace = runtime._trace_service.load(runtime._config.session_id)
    rendered_trace = "\n".join(str(event.to_dict()) for event in trace)

    assert response.assistant_message == "Recovered without encrypted replay"
    assert adapter.calls == 2
    assert adapter.continuation_states == [initial_state, None]
    assert runtime._session_service.load_responses_continuation_state(
        runtime._config.session_id
    ) is None
    assert response.turn is not None
    warning = next(
        item
        for item in response.turn.items
        if item.type is TurnItemType.WARNING
        and item.metadata.get("recovery_error_class") == "invalid_encrypted_content"
    )
    assert warning.metadata["recovery_kind"] == "strip_encrypted_reasoning_retry"
    assert warning.metadata["action"] == "strip_encrypted_reasoning_retry"
    assert "sk-do-not-print" not in rendered_trace
    recovery_event = next(event for event in trace if event.kind == "recovery_diagnostic")
    assert recovery_event.payload["error_class"] == "invalid_encrypted_content"
    assert recovery_event.payload["action"] == "strip_encrypted_reasoning_retry"
    assert recovery_event.payload["will_retry"] is True


def test_turn_executor_uses_fallback_model_after_retry_exhaustion(tmp_path: Path) -> None:
    adapter = FallbackModelAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._recovery_sleep = lambda delay: None
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        model="primary-model",
        fallback_model="fallback-model",
        transport_retry_limit=1,
    )

    response = runtime.handle_user_turn("inspect")

    assert response.assistant_message == "Recovered on fallback model"
    assert adapter.models_seen == ["primary-model", "primary-model", "fallback-model"]
    assert adapter.model == "primary-model"
    assert any(
        item.type is TurnItemType.WARNING
        and item.metadata.get("recovery_kind") == "fallback_model"
        and item.metadata.get("to_model") == "fallback-model"
        for item in response.turn.items
    )


def test_turn_executor_context_window_recovery_adds_retry_reminder() -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=Path.cwd(),
        home_dir=Path.cwd() / ".tmp-turn-recovery-home",
        model_adapter=KeyboardInterruptAdapter(),
    )
    executor = TurnExecutor(runtime)

    recovery = executor._recovery_action_for_model_error(
        exc=ModelResponseError(
            "context window overflow",
            stop_reason=StopReason.CONTEXT_WINDOW_EXCEEDED,
            failure_kind="context_window_exceeded",
        ),
        loop_state=LoopState(),
        runtime_reminders=(),
    )

    assert recovery.should_retry is True
    assert recovery.next_state.context_window_retries == 1
    assert recovery.next_state.context_recovery_stage == "collapse_drain"
    assert any("context window" in reminder.lower() for reminder in recovery.runtime_reminders)


def test_turn_executor_context_window_recovery_drains_then_reactive_compacts(
    tmp_path: Path,
) -> None:
    adapter = ContextWindowDrainCompactThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect")

    assert response.assistant_message == "Recovered after compaction"
    assert adapter.calls == 3
    assert response.turn is not None
    warnings = [
        item.text
        for item in response.turn.items
        if item.type is TurnItemType.WARNING and item.text
    ]
    assert any("draining redundant context" in warning.lower() for warning in warnings)
    assert any("reactive compaction" in warning.lower() for warning in warnings)


def test_turn_executor_retries_context_window_drain_and_compact_before_final_failure(
    tmp_path: Path,
) -> None:
    adapter = ContextWindowRetryThenFailAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    response = runtime.handle_user_turn("inspect")

    assert response.turn is not None
    assert response.turn.stop_reason is StopReason.CONTEXT_WINDOW_EXCEEDED
    assert response.turn.status is TurnStatus.FAILED
    assert adapter.calls == 3
    assert any(
        item.type is TurnItemType.WARNING and item.text and "context window" in item.text.lower()
        for item in response.turn.items
    )


def test_turn_executor_output_token_limit_escalates_and_recovers(
    tmp_path: Path,
) -> None:
    adapter = OutputTokenEscalateThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        max_output_tokens=2048,
        output_limit_escalation_max_tokens=32_768,
        output_recovery_retry_limit=2,
    )

    response = runtime.handle_user_turn("write a long answer")

    assert response.assistant_message == "Recovered with more output budget"
    assert adapter.output_token_budgets == [32_768, 2048]
    assert len(adapter.seen_items) == 2
    assert "output budget" not in _runtime_reminder_text(adapter.seen_items[1]).lower()
    assert response.turn is not None
    assert any(
        item.type is TurnItemType.WARNING
        and item.metadata.get("recovery_kind") == "output_token_recovery"
        and item.metadata.get("escalated_max_output_tokens") == 32_768
        for item in response.turn.items
    )


def test_turn_executor_emits_heartbeat_without_model_visible_context(tmp_path: Path) -> None:
    ticks = [0.0]

    def monotonic() -> float:
        ticks[0] += 2.0
        return ticks[0]

    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=SlowSuccessfulAdapter(),
    )
    runtime._monotonic = monotonic
    runtime._config = AgentConfig(
        workspace_root=tmp_path,
        heartbeat_enabled=True,
        heartbeat_interval_seconds=1.0,
    )
    stream_events: list[RuntimeStreamEvent] = []

    response = runtime.handle_user_turn("inspect", stream_sink=stream_events.append)

    assert response.assistant_message == "Done after silence"
    assert any(event.kind == "heartbeat" for event in stream_events)
    assert any("[heartbeat]" in update for update in response.progress_updates)
    history = runtime._session_service.load_history_items(runtime._config.session_id)
    assert all("[heartbeat]" not in (item.text or "") for item in history)


def test_turn_executor_finalizes_keyboard_interrupt_with_preserved_warning(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home_dir,
        model_adapter=KeyboardInterruptAdapter(),
    )

    response = runtime.handle_user_turn("inspect")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.INTERRUPTED
    assert response.turn.stop_reason is StopReason.INTERRUPTED
    suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
    assert suspended is not None
    assert suspended.suspend_reason is StopReason.INTERRUPTED
    assert any(
        item.type is TurnItemType.WARNING
        and item.text
        and "interrupt" in item.text.lower()
        and item.metadata.get("recovery_kind") == "interrupted_turn_saved"
        for item in response.turn.items
    )
    trace = runtime._trace_service.load(runtime._config.session_id)
    interrupted_event = next(event for event in trace if event.kind == "turn_interrupted")
    assert interrupted_event.turn_id == response.turn.turn_id
    assert interrupted_event.payload == {
        "session_id": runtime._config.session_id,
        "turn_id": response.turn.turn_id,
        "stop_reason": "interrupted",
        "suspend_reason": "interrupted",
        "saved_state": True,
        "message_count": 1,
    }
    agent_log = runtime._workspace_log_service.agent_log_path().read_text(encoding="utf-8")
    assert "turn_interrupted" in agent_log
    assert response.turn.turn_id in agent_log


def test_turn_executor_saves_and_resumes_interrupted_turn(
    tmp_path: Path,
) -> None:
    adapter = InterruptOnceThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )
    runtime.rebind_session(replace(runtime._config, memory_enabled=False))

    interrupted = runtime.handle_user_turn("inspect interrupted path")

    assert interrupted.turn is not None
    assert interrupted.turn.status is TurnStatus.INTERRUPTED
    suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
    assert suspended is not None
    assert suspended.pending_approval is None
    assert suspended.user_message == "inspect interrupted path"

    resumed = runtime.handle_user_turn("继续")

    assert resumed.assistant_message == "Resumed after interrupt"
    assert adapter.calls == 2
    assert runtime._session_service.load_suspended_turn(runtime._config.session_id) is None


def test_turn_executor_saves_interrupted_turn_during_pre_request_compaction(
    tmp_path: Path,
) -> None:
    adapter = InterruptOnceThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

    def interrupt_compaction(conversation, budget):
        del conversation, budget
        raise KeyboardInterrupt()

    runtime._compaction_pipeline.apply = interrupt_compaction  # type: ignore[method-assign]

    interrupted = runtime.handle_user_turn("inspect interrupted l4 path")

    assert interrupted.turn is not None
    assert interrupted.turn.status is TurnStatus.INTERRUPTED
    assert adapter.calls == 0
    suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
    assert suspended is not None
    assert suspended.pending_approval is None
    assert suspended.user_message == "inspect interrupted l4 path"


def test_repair_interrupted_tool_results_appends_missing_tool_result() -> None:
    conversation = Conversation(
        session_id="demo",
        messages=[
            Message(role="user", content="inspect"),
            Message(
                role="assistant",
                content="",
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"file_path": "README.md"},
                        reason="inspect file",
                        call_id="call_read_1",
                    ),
                ),
            ),
        ],
    )

    repaired = _repair_interrupted_tool_results(conversation)

    assert len(repaired) == 1
    assert repaired[0] is conversation.messages[-1]
    assert repaired[0].role == "tool"
    assert repaired[0].tool_call_id == "call_read_1"
    assert repaired[0].metadata == {
        "success": False,
        "error_kind": "tool_interrupted",
        "synthetic": True,
        "append_only": True,
    }
    assert repaired[0].blocks == (
        RuntimeBlock(
            type="tool_result",
            text="Tool call interrupted by user before it completed.",
            call_id="call_read_1",
            metadata={
                "success": False,
                "error_kind": "tool_interrupted",
                "synthetic": True,
            },
        ),
    )


def test_repair_interrupted_tool_results_does_not_duplicate_existing_result() -> None:
    conversation = Conversation(
        session_id="demo",
        messages=[
            Message(role="user", content="inspect"),
            Message(
                role="assistant",
                content="",
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"file_path": "README.md"},
                        reason="inspect file",
                        call_id="call_read_1",
                    ),
                ),
            ),
            Message(role="tool", content="contents", tool_call_id="call_read_1"),
        ],
    )

    repaired = _repair_interrupted_tool_results(conversation)

    assert repaired == ()
    assert [message.role for message in conversation.messages] == [
        "user",
        "assistant",
        "tool",
    ]


def test_turn_executor_interrupted_finalization_repairs_dangling_tool_call(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=InterruptOnceThenDoneAdapter(),
    )
    runtime.rebind_session(replace(runtime._config, memory_enabled=False))
    executor = TurnExecutor(runtime)
    conversation = Conversation(
        session_id=runtime._config.session_id,
        messages=[
            Message(role="user", content="inspect"),
            Message(
                role="assistant",
                content="",
                tool_calls=(
                    ToolCall(
                        name="Read",
                        arguments={"file_path": "README.md"},
                        reason="inspect file",
                        call_id="call_read_1",
                    ),
                ),
            ),
        ],
    )
    turn_items = []

    response = executor._finalize_interrupted_turn(
        user_message="inspect",
        conversation=conversation,
        current_plan_state=PlanState(),
        turn_id="turn_interrupted",
        started_at=runtime._timestamp(),
        turn_items=turn_items,
        latest_context_baseline=None,
        activity_events=[],
        streamed_chunks=[],
        progress_updates=[],
    )

    assert response.turn is not None
    assert response.turn.status is TurnStatus.INTERRUPTED
    suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
    assert suspended is not None
    assert suspended.conversation[-1].role == "tool"
    assert suspended.conversation[-1].tool_call_id == "call_read_1"
    assert suspended.conversation[-1].metadata["synthetic"] is True
    assert any(
        item.type is TurnItemType.TOOL_RESULT
        and item.call_id == "call_read_1"
        and item.metadata.get("recovery_kind") == "interrupted_missing_tool_result"
        for item in response.turn.items
    )

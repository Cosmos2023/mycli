from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.application.runtime.turn_executor import (
    BudgetNudge,
    LoopState,
    TurnExecutor,
    _apply_l4_recent_file_hints,
)
from mycli.domain.runtime import (
    ModelTurnResult,
    RuntimeBlock,
    RuntimeItem,
    StopReason,
    TurnItemType,
    TurnStatus,
)
from mycli.llms.clients.openai_chat import ModelResponseError
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

    response = runtime.handle_user_turn("write a long answer")

    assert response.assistant_message == "Recovered with more output budget"
    assert adapter.output_token_budgets == [65_536]
    assert len(adapter.seen_items) == 2
    assert "output budget" in _runtime_reminder_text(adapter.seen_items[1]).lower()


def test_turn_executor_finalizes_keyboard_interrupt_with_preserved_warning(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=KeyboardInterruptAdapter(),
    )

    response = runtime.handle_user_turn("inspect")

    assert response.turn is not None
    assert response.turn.status is TurnStatus.INTERRUPTED
    assert response.turn.stop_reason is StopReason.MODEL_ERROR
    assert any(
        item.type is TurnItemType.WARNING and item.text and "interrupt" in item.text.lower()
        for item in response.turn.items
    )


def test_turn_executor_saves_and_resumes_interrupted_turn(
    tmp_path: Path,
) -> None:
    adapter = InterruptOnceThenDoneAdapter()
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=adapter,
    )

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

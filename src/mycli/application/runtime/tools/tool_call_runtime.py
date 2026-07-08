from __future__ import annotations

from collections.abc import Callable, Collection, Sequence
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Generic, TypeVar

from mycli.domain.runtime import PlanState, RuntimeInterruptToken
from mycli.domain.tooling.calls import ToolCall

OutcomeT = TypeVar("OutcomeT")

ToolCallExecutor = Callable[[ToolCall, PlanState], OutcomeT]
ToolBatchExecutor = Callable[[tuple[ToolCall, ...], PlanState], Sequence[OutcomeT]]
OutcomeApplier = Callable[[OutcomeT], PlanState]
AbortOutcomeFactory = Callable[[ToolCall, PlanState], OutcomeT]


@dataclass(slots=True)
class ToolCallRuntime(Generic[OutcomeT]):
    """Coordinates turn-local tool call batching and cancellation checks."""

    concurrency_safe_tools: Collection[str]
    execute_call: ToolCallExecutor[OutcomeT] | None = None
    execute_batch: ToolBatchExecutor[OutcomeT] | None = None
    abort_outcome: AbortOutcomeFactory[OutcomeT] | None = None
    interrupt_token: RuntimeInterruptToken | None = None

    def execute_calls(
        self,
        *,
        calls: list[ToolCall] | tuple[ToolCall, ...],
        plan_state: PlanState,
        apply_outcome: OutcomeApplier[OutcomeT] | None = None,
    ) -> PlanState:
        self._raise_if_interrupted()
        current_plan_state = plan_state
        pending_safe_calls: list[ToolCall] = []

        def apply_runtime_outcome(outcome: OutcomeT) -> None:
            nonlocal current_plan_state
            if apply_outcome is None:
                current_plan_state = outcome  # type: ignore[assignment]
            else:
                current_plan_state = apply_outcome(outcome)

        def record_batch_abort(batch: tuple[ToolCall, ...]) -> None:
            if self.abort_outcome is None or len(batch) <= 1:
                return
            for aborted_call in batch:
                apply_runtime_outcome(self.abort_outcome(aborted_call, current_plan_state))

        def flush_safe_calls() -> None:
            self._raise_if_interrupted()
            if not pending_safe_calls:
                return
            batch = tuple(pending_safe_calls)
            pending_safe_calls.clear()
            try:
                outcomes = self._execute_batch(batch, current_plan_state)
            except KeyboardInterrupt:
                record_batch_abort(batch)
                raise
            for outcome in outcomes:
                apply_runtime_outcome(outcome)

        for call in calls:
            self._raise_if_interrupted()
            if call.name in self.concurrency_safe_tools:
                pending_safe_calls.append(call)
                continue
            flush_safe_calls()
            batch = (call,)
            try:
                outcomes = self._execute_batch(batch, current_plan_state)
            except KeyboardInterrupt:
                record_batch_abort(batch)
                raise
            for outcome in outcomes:
                apply_runtime_outcome(outcome)
        flush_safe_calls()
        return current_plan_state

    def _raise_if_interrupted(self) -> None:
        if self.interrupt_token is not None:
            self.interrupt_token.raise_if_interrupted()

    def _execute_batch(
        self,
        calls: tuple[ToolCall, ...],
        plan_state: PlanState,
    ) -> Sequence[OutcomeT]:
        if self.execute_batch is not None:
            return self.execute_batch(calls, plan_state)
        if self.execute_call is None:
            raise ValueError("ToolCallRuntime requires execute_call or execute_batch.")
        if len(calls) == 1:
            return (self.execute_call(calls[0], plan_state),)

        executor = ThreadPoolExecutor(max_workers=len(calls))
        futures: list[Future[OutcomeT]] = [
            executor.submit(self.execute_call, call, plan_state) for call in calls
        ]
        pending = set(futures)
        try:
            while pending:
                self._raise_if_interrupted()
                done, pending = wait(
                    pending,
                    timeout=0.05,
                    return_when=FIRST_COMPLETED,
                )
                for future in done:
                    exc = future.exception()
                    if exc is not None:
                        raise exc
            self._raise_if_interrupted()
            return tuple(future.result() for future in futures)
        except BaseException:
            executor.shutdown(wait=False, cancel_futures=True)
            raise
        finally:
            if not pending:
                executor.shutdown(wait=True)

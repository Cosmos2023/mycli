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
SupportsParallelToolCall = Callable[[ToolCall], bool]


@dataclass(slots=True)
class ToolCallRuntime(Generic[OutcomeT]):
    """Coordinates turn-local read/write tool phases and cancellation repair."""

    concurrency_safe_tools: Collection[str]
    supports_parallel_tool_call: SupportsParallelToolCall | None = None
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
        ordered_calls = tuple(calls)
        current_plan_state = plan_state
        pending_safe_calls: list[tuple[int, ToolCall]] = []
        completed_indexes: set[int] = set()
        aborted_indexes: set[int] = set()

        def apply_runtime_outcome(outcome: OutcomeT) -> None:
            nonlocal current_plan_state
            if apply_outcome is None:
                current_plan_state = outcome  # type: ignore[assignment]
            else:
                current_plan_state = apply_outcome(outcome)

        def record_aborted_calls(entries: tuple[tuple[int, ToolCall], ...]) -> None:
            if self.abort_outcome is None:
                return
            for index, aborted_call in entries:
                if index in completed_indexes or index in aborted_indexes:
                    continue
                aborted_indexes.add(index)
                apply_runtime_outcome(self.abort_outcome(aborted_call, current_plan_state))

        def mark_completed(entries: tuple[tuple[int, ToolCall], ...]) -> None:
            for index, _call in entries:
                completed_indexes.add(index)

        def remaining_entries(start_index: int) -> tuple[tuple[int, ToolCall], ...]:
            return tuple(
                (index, ordered_calls[index])
                for index in range(start_index, len(ordered_calls))
                if index not in completed_indexes and index not in aborted_indexes
            )

        def flush_safe_calls(
            *,
            abort_tail: tuple[tuple[int, ToolCall], ...] = (),
        ) -> None:
            self._raise_if_interrupted()
            if not pending_safe_calls:
                return
            batch = tuple(pending_safe_calls)
            pending_safe_calls.clear()
            try:
                outcomes = self._execute_batch(
                    tuple(call for _index, call in batch),
                    current_plan_state,
                )
            except KeyboardInterrupt:
                record_aborted_calls((*batch, *abort_tail))
                raise
            for outcome in outcomes:
                apply_runtime_outcome(outcome)
            mark_completed(batch)

        for index, call in enumerate(ordered_calls):
            self._raise_if_interrupted()
            if self._supports_parallel(call):
                pending_safe_calls.append((index, call))
                continue
            flush_safe_calls(abort_tail=remaining_entries(index))
            batch = ((index, call),)
            try:
                outcomes = self._execute_batch((call,), current_plan_state)
            except KeyboardInterrupt:
                record_aborted_calls((*batch, *remaining_entries(index + 1)))
                raise
            for outcome in outcomes:
                apply_runtime_outcome(outcome)
            mark_completed(batch)
        flush_safe_calls()
        return current_plan_state

    def _raise_if_interrupted(self) -> None:
        if self.interrupt_token is not None:
            self.interrupt_token.raise_if_interrupted()

    def _supports_parallel(self, call: ToolCall) -> bool:
        if self.supports_parallel_tool_call is not None:
            return self.supports_parallel_tool_call(call)
        return call.name in self.concurrency_safe_tools

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

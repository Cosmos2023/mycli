from __future__ import annotations

from typing import TYPE_CHECKING

from mycli.domain.runtime import (
    ActivityEvent,
    ContextBaseline,
    PlanState,
    StopReason,
    TurnItem,
    TurnItemType,
    TurnResponse,
    TurnStatus,
)
from mycli.llms.clients.openai_chat import ModelResponseError

if TYPE_CHECKING:
    from mycli.application.runtime.agent_runtime import AgentRuntime


class TurnErrorFinalizer:
    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime

    def finalize_model_error(
        self,
        *,
        user_message: str,
        current_plan_state: PlanState,
        turn_id: str,
        started_at: str,
        turn_items: list[TurnItem],
        latest_context_baseline: ContextBaseline | None,
        activity_events: list[ActivityEvent],
        progress_updates: list[str],
        exc: ModelResponseError,
        phase: str,
        stop_reason: StopReason,
        assistant_message: str,
    ) -> TurnResponse:
        runtime = self._runtime
        runtime._persist_model_continuation_state(turn_id=turn_id, phase=phase)
        activity_events.append(
            ActivityEvent(kind="model_error", message=f"Model error: {exc}")
        )
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.WARNING,
                text=f"Model error: {exc}",
            ),
        )
        error_path = exc.error_path or runtime._log_runtime_exception(
            turn_id=turn_id,
            phase="model_request_failed",
            exc=exc,
        )
        return runtime._finalize_response(
            response=TurnResponse(
                assistant_message=assistant_message,
                activity_events=tuple(activity_events),
                error_details=runtime._error_details(error_path),
                progress_updates=tuple(progress_updates),
                plan_steps=runtime._planning_service.render_steps(current_plan_state),
            ),
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=TurnStatus.FAILED,
            stop_reason=stop_reason,
            turn_items=turn_items,
            context_baseline=latest_context_baseline,
        )

    def finalize_runtime_exception(
        self,
        *,
        user_message: str,
        current_plan_state: PlanState,
        turn_id: str,
        started_at: str,
        turn_items: list[TurnItem],
        latest_context_baseline: ContextBaseline | None,
        activity_events: list[ActivityEvent],
        progress_updates: list[str],
        exc: Exception,
    ) -> TurnResponse:
        runtime = self._runtime
        runtime._persist_model_continuation_state(
            turn_id=turn_id,
            phase="runtime_error",
        )
        activity_events.append(
            ActivityEvent(kind="model_error", message=f"Runtime error: {exc}")
        )
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.WARNING,
                text=f"Runtime error: {exc}",
            ),
        )
        error_path = runtime._log_runtime_exception(
            turn_id=turn_id,
            phase="runtime_error",
            exc=exc,
        )
        return runtime._finalize_response(
            response=TurnResponse(
                assistant_message=f"Internal runtime error: {exc}",
                activity_events=tuple(activity_events),
                error_details=runtime._error_details(error_path),
                progress_updates=tuple(progress_updates),
                plan_steps=runtime._planning_service.render_steps(current_plan_state),
            ),
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=TurnStatus.FAILED,
            stop_reason=StopReason.RUNTIME_ERROR,
            turn_items=turn_items,
            context_baseline=latest_context_baseline,
        )

from __future__ import annotations

from mycli.domain.runtime import PlanState
from mycli.domain.tooling.calls import ToolCall
from mycli.services.planning.planning_service import PlanningService
from mycli.state.session_service import SessionService


class RuntimePlanningEffects:
    def __init__(
        self,
        *,
        session_id: str,
        planning_service: PlanningService,
        session_service: SessionService,
    ) -> None:
        self._session_id = session_id
        self._planning_service = planning_service
        self._session_service = session_service

    def set_session_id(self, session_id: str) -> None:
        self._session_id = session_id

    def apply_tool_effects(
        self,
        *,
        call: ToolCall,
        result_payload: dict[str, object],
        plan_state: PlanState,
    ) -> PlanState:
        if call.name != "update_plan":
            return plan_state
        items = result_payload.get("items", [])
        if not isinstance(items, list):
            return plan_state
        next_plan = self._planning_service.replace(items)
        self._session_service.save_plan_state(self._session_id, next_plan)
        return next_plan

    def complete_task_if_active(
        self,
        plan_state: PlanState,
        item_id: str | None,
    ) -> PlanState:
        if item_id is None:
            return plan_state
        current_item_id = plan_state.current_in_progress_item_id()
        if current_item_id != item_id:
            return plan_state
        return self._planning_service.mark_completed(plan_state, item_id)

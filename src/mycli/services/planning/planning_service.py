from __future__ import annotations

from typing import Any

from mycli.domain.runtime import PlanItem, PlanState, PlanStatus


class PlanningService:
    def replace(self, items: list[dict[str, Any]]) -> PlanState:
        plan_items = tuple(
            self._normalize_item(item, index=index)
            for index, item in enumerate(items, start=1)
        )
        return PlanState(items=plan_items)

    def render_steps(self, plan_state: PlanState) -> tuple[str, ...]:
        return tuple(
            f"{item.status.value}: {item.content}"
            for item in plan_state.items
        )

    def mark_completed(self, state: PlanState, item_id: str) -> PlanState:
        return state.replace_item(item_id, PlanStatus.COMPLETED)

    def mark_in_progress(self, state: PlanState, item_id: str) -> PlanState:
        return state.replace_item(item_id, PlanStatus.IN_PROGRESS)

    def _normalize_item(self, item: dict[str, Any], *, index: int) -> PlanItem:
        raw_id = item.get("id")
        item_id = str(raw_id).strip() if raw_id is not None and str(raw_id).strip() else f"step-{index}"

        raw_content = item.get("content")
        if not isinstance(raw_content, str) or not raw_content.strip():
            raw_content = item.get("description")
        if not isinstance(raw_content, str) or not raw_content.strip():
            raw_content = item.get("title")
        content = (
            raw_content.strip()
            if isinstance(raw_content, str) and raw_content.strip()
            else f"Step {index}"
        )

        raw_status = item.get("status", PlanStatus.PENDING.value)
        try:
            status = PlanStatus(str(raw_status))
        except ValueError:
            status = PlanStatus.PENDING

        return PlanItem(
            id=item_id,
            content=content,
            status=status,
        )

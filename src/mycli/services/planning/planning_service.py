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

    def apply_operation(self, state: PlanState, payload: dict[str, Any]) -> PlanState:
        op = str(payload.get("op", "replace")).strip().lower()
        if op == "replace":
            items = payload.get("items")
            if not isinstance(items, list):
                items = payload.get("plan")
            if not isinstance(items, list):
                return state
            return self.replace(items)
        if op == "add":
            item = payload.get("item")
            if not isinstance(item, dict):
                item = payload
            plan_item = self._normalize_item(item, index=len(state.items) + 1)
            return PlanState(items=(*state.items, plan_item))
        if op in {"update", "start", "complete", "remove"}:
            item_id = self._item_id(payload)
            if item_id is None:
                return state
            if op == "remove":
                return PlanState(items=tuple(item for item in state.items if item.id != item_id))
            status = self._operation_status(op, payload)
            return self._update_item(
                state,
                item_id=item_id,
                content=payload.get("content") or payload.get("step") or payload.get("description"),
                status=status,
                evidence=payload.get("evidence"),
            )
        return state

    def render_steps(self, plan_state: PlanState) -> tuple[str, ...]:
        return tuple(
            f"{item.status.value}: {item.content}"
            for item in plan_state.items
        )

    def mark_completed(self, state: PlanState, item_id: str) -> PlanState:
        return state.replace_item(item_id, PlanStatus.COMPLETED)

    def _normalize_item(self, item: dict[str, Any], *, index: int) -> PlanItem:
        raw_id = item.get("id")
        item_id = str(raw_id).strip() if raw_id is not None and str(raw_id).strip() else f"step-{index}"

        raw_content = item.get("content")
        if not isinstance(raw_content, str) or not raw_content.strip():
            raw_content = item.get("description")
        if not isinstance(raw_content, str) or not raw_content.strip():
            raw_content = item.get("step")
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
            evidence=self._normalize_evidence(item.get("evidence")),
        )

    def _update_item(
        self,
        state: PlanState,
        *,
        item_id: str,
        content: object,
        status: PlanStatus | None,
        evidence: object,
    ) -> PlanState:
        next_items: list[PlanItem] = []
        for item in state.items:
            next_status = status if item.id == item_id and status is not None else item.status
            if item.id != item_id and next_status is PlanStatus.IN_PROGRESS:
                next_status = PlanStatus.PENDING
            next_content = item.content
            if item.id == item_id and isinstance(content, str) and content.strip():
                next_content = content.strip()
            next_evidence = item.evidence
            if item.id == item_id and evidence is not None:
                next_evidence = self._normalize_evidence(evidence)
            next_items.append(
                PlanItem(
                    id=item.id,
                    content=next_content,
                    status=next_status,
                    evidence=next_evidence,
                )
            )
        return PlanState(items=tuple(next_items))

    def _item_id(self, payload: dict[str, Any]) -> str | None:
        value = payload.get("item_id") or payload.get("id")
        if not isinstance(value, str) or not value.strip():
            return None
        return value.strip()

    def _operation_status(self, op: str, payload: dict[str, Any]) -> PlanStatus | None:
        if op == "start":
            return PlanStatus.IN_PROGRESS
        if op == "complete":
            return PlanStatus.COMPLETED
        value = payload.get("status")
        if value is None:
            return None
        try:
            return PlanStatus(str(value))
        except ValueError:
            return PlanStatus.PENDING

    def _normalize_evidence(self, value: object) -> tuple[str, ...]:
        if isinstance(value, str) and value.strip():
            return (value.strip(),)
        if not isinstance(value, list):
            return ()
        evidence: list[str] = []
        for item in value:
            if isinstance(item, str) and item.strip():
                evidence.append(item.strip())
        return tuple(evidence)

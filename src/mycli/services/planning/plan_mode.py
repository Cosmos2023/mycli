from __future__ import annotations

import re
from pathlib import Path

from mycli.domain.runtime import PlanItem, PlanState, PlanStatus


class PlanModeService:
    def __init__(self, *, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    @property
    def plan_path(self) -> Path:
        return self._workspace_root / "docs" / "tasks" / "current.md"

    def write_current_plan(self, state: PlanState) -> Path:
        self.plan_path.parent.mkdir(parents=True, exist_ok=True)
        self.plan_path.write_text(self.render_plan(state), encoding="utf-8")
        return self.plan_path

    def load_current_plan(self) -> PlanState:
        if not self.plan_path.exists():
            return PlanState()
        return self.parse_plan(self.plan_path.read_text(encoding="utf-8"))

    def render_plan(self, state: PlanState) -> str:
        lines = ["# Current Plan", ""]
        for item in state.items:
            marker = self._marker_for_status(item.status)
            lines.append(f"- [{marker}] {item.content}")
        return "\n".join(lines) + "\n"

    def parse_plan(self, content: str) -> PlanState:
        items: list[PlanItem] = []
        for line in content.splitlines():
            match = re.match(r"^\s*-\s*\[([xX~ ])\]\s+(.+?)\s*$", line)
            if match is None:
                continue
            marker, text = match.groups()
            items.append(
                PlanItem(
                    id=f"step-{len(items) + 1}",
                    content=text.strip(),
                    status=self._status_for_marker(marker),
                )
            )
        return PlanState(items=tuple(items))

    def _marker_for_status(self, status: PlanStatus) -> str:
        if status is PlanStatus.COMPLETED:
            return "x"
        if status is PlanStatus.IN_PROGRESS:
            return "~"
        return " "

    def _status_for_marker(self, marker: str) -> PlanStatus:
        if marker.lower() == "x":
            return PlanStatus.COMPLETED
        if marker == "~":
            return PlanStatus.IN_PROGRESS
        return PlanStatus.PENDING


__all__ = ["PlanModeService"]

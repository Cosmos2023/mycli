from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.services.planning import PlanningService, PlanModeService
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


class EnterPlanModeTool:
    name = "enter_plan_mode"
    spec = ToolSpec(
        name="enter_plan_mode",
        description="Create or replace docs/tasks/current.md from a structured task plan. Use for complex tasks that need a durable plan anchor.",
        parameters=(
            ToolParameter(
                name="items",
                type="array",
                required=True,
                items_schema={
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "content": {"type": "string"},
                        "description": {"type": "string"},
                        "status": {"type": "string"},
                    },
                    "required": ["status"],
                    "additionalProperties": False,
                },
            ),
        ),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._plan_mode = PlanModeService(workspace_root=workspace_root)
        self._planning = PlanningService()

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        items = arguments.get("items", [])
        if not isinstance(items, list):
            return ToolResult(
                success=False,
                summary="Invalid plan mode payload",
                error="enter_plan_mode requires an 'items' list.",
            )
        state = self._planning.replace(items)
        path = self._plan_mode.write_current_plan(state)
        return ToolResult(
            success=True,
            summary=f"Wrote plan mode anchor to {path.relative_to(self._plan_mode.plan_path.parents[2]).as_posix()}",
            raw_payload={
                "path": "docs/tasks/current.md",
                "items": [
                    {
                        "id": item.id,
                        "content": item.content,
                        "status": item.status.value,
                    }
                    for item in state.items
                ],
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


class ExitPlanModeTool:
    name = "exit_plan_mode"
    spec = ToolSpec(
        name="exit_plan_mode",
        description="Read docs/tasks/current.md and return the structured plan state. Use when leaving plan mode or recovering after a crash.",
        parameters=(),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._plan_mode = PlanModeService(workspace_root=workspace_root)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        del arguments
        state = self._plan_mode.load_current_plan()
        return ToolResult(
            success=True,
            summary=f"Loaded {len(state.items)} plan item(s) from docs/tasks/current.md",
            raw_payload={
                "path": "docs/tasks/current.md",
                "items": [
                    {
                        "id": item.id,
                        "content": item.content,
                        "status": item.status.value,
                    }
                    for item in state.items
                ],
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


__all__ = ["EnterPlanModeTool", "ExitPlanModeTool"]


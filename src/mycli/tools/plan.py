from __future__ import annotations

from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


class PlanTool:
    name = "Plan"
    spec = ToolSpec(
        name="Plan",
        description="Manage the task plan for complex multi-step work.",
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

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        items = arguments.get("items", [])
        if not isinstance(items, list):
            return ToolResultV2(
                success=False,
                summary="Invalid plan payload",
                error="Plan requires an 'items' list.",
            )
        return ToolResultV2(
            success=True,
            summary=f"Updated plan with {len(items)} items",
            raw_payload={"items": items},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()


class UpdatePlanTool(PlanTool):
    name = "Plan"

from __future__ import annotations

from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


class PlanTool:
    name = "Plan"
    spec = ToolSpec(
        name="Plan",
        description="Manage the task plan for complex multi-step work.",
        parameters=(
            ToolParameter(
                name="op",
                type="string",
                required=False,
                description="Optional operation: replace, add, update, start, complete, or remove. Defaults to replace.",
            ),
            ToolParameter(
                name="items",
                type="array",
                required=False,
                items_schema={
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "content": {"type": "string"},
                        "description": {"type": "string"},
                        "step": {"type": "string"},
                        "status": {"type": "string"},
                        "evidence": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": [],
                    "additionalProperties": False,
                },
            ),
            ToolParameter(
                name="plan",
                type="array",
                required=False,
                description="Codex-compatible full plan payload using step/status rows.",
                items_schema={
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "step": {"type": "string"},
                        "content": {"type": "string"},
                        "status": {"type": "string"},
                    },
                    "required": [],
                    "additionalProperties": False,
                },
            ),
            ToolParameter(name="item_id", type="string", required=False),
            ToolParameter(name="id", type="string", required=False),
            ToolParameter(name="content", type="string", required=False),
            ToolParameter(name="step", type="string", required=False),
            ToolParameter(name="status", type="string", required=False),
            ToolParameter(
                name="evidence",
                type="array",
                required=False,
                items_schema={"type": "string"},
            ),
            ToolParameter(
                name="item",
                type="object",
                required=False,
                description="Plan item used by add operations.",
            ),
        ),
        risk_level="low",
    )

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        op = arguments.get("op")
        if op is not None and not isinstance(op, str):
            return ToolResult(
                success=False,
                summary="Invalid plan payload",
                error="Plan 'op' must be a string.",
            )
        items = arguments.get("items")
        plan = arguments.get("plan")
        if items is not None and not isinstance(items, list):
            return ToolResult(
                success=False,
                summary="Invalid plan payload",
                error="Plan 'items' must be a list when provided.",
            )
        if plan is not None and not isinstance(plan, list):
            return ToolResult(
                success=False,
                summary="Invalid plan payload",
                error="Plan 'plan' must be a list when provided.",
            )
        if op is None and items is None and plan is None:
            return ToolResult(
                success=False,
                summary="Invalid plan payload",
                error="Plan requires 'items', 'plan', or an 'op'.",
            )
        item_count = len(items) if isinstance(items, list) else len(plan) if isinstance(plan, list) else 0
        return ToolResult(
            success=True,
            summary=f"Updated plan with {item_count} items" if item_count else "Updated plan",
            raw_payload=dict(arguments),
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)

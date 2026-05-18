from __future__ import annotations

from mycli.domain.tooling.contributed_tools import (
    ToolContributionLifecycleEvent,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
)
from mycli.domain.tooling.exposure import ToolExposure
from mycli.domain.tooling.tool_set import ToolSet
from mycli.domain.tooling.calls import ToolCall
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.llms.adapters.base import ModelToolDefinition, ModelToolParameter
from mycli.tools.base import ToolResult
from mycli.tools.registry import ToolRegistry


class ToolRouter:
    def __init__(
        self,
        *,
        tool_registry: ToolRegistry,
        contributed_tools: dict[str, ToolContributionRegistration] | None = None,
        contributed_tool_registry: ToolContributionRegistry | None = None,
    ) -> None:
        self._tool_registry = tool_registry
        self._contributed_tools = {} if contributed_tools is None else dict(contributed_tools)
        self._contributed_tool_registry = contributed_tool_registry
        self._lifecycle_events: list[ToolContributionLifecycleEvent] = []

    def render_for_model(self, exposure: ToolExposure) -> list[ModelToolDefinition]:
        tool_set = ToolSet.from_exposure(exposure)
        return [
            ModelToolDefinition(
                name=entry.name,
                description=entry.spec.description,
                parameters=tuple(
                    ModelToolParameter(
                        name=parameter.name,
                        type=parameter.type,
                        required=parameter.required,
                        description=parameter.description,
                        items_schema=parameter.items_schema,
                    )
                    for parameter in entry.spec.parameters
                ),
            )
            for entry in tool_set.model_visible_entries()
        ]

    def execute(self, call: ToolCall, *, exposure: ToolExposure) -> ToolResult:
        allowed_names = set(exposure.callable_tool_names())
        if call.name not in allowed_names:
            rendered = ", ".join(sorted(allowed_names)) or "none"
            raise ValueError(
                f"Tool '{call.name}' is not exposed for this turn. Callable tools: {rendered}."
            )
        contributed_tool = self._contributed_tools.get(call.name)
        if contributed_tool is not None:
            self._record_contribution_transition(
                contributed_tool.descriptor.tool_id,
                ToolContributionLifecycleState.INVOKED,
            )
            try:
                result = contributed_tool.tool.execute(call.arguments)
            except Exception:
                self._record_contribution_transition(
                    contributed_tool.descriptor.tool_id,
                    ToolContributionLifecycleState.FAILED,
                )
                raise
            self._record_contribution_transition(
                contributed_tool.descriptor.tool_id,
                ToolContributionLifecycleState.COMPLETED,
            )
            return result
        return self._tool_registry.execute(call)

    def pop_lifecycle_events(self) -> tuple[ToolContributionLifecycleEvent, ...]:
        events = tuple(self._lifecycle_events)
        self._lifecycle_events.clear()
        return events

    def _record_contribution_transition(
        self,
        tool_id: str,
        state: ToolContributionLifecycleState,
    ) -> None:
        if self._contributed_tool_registry is None:
            return
        event = self._contributed_tool_registry.transition(tool_id, state)
        if event is not None:
            self._lifecycle_events.append(event)

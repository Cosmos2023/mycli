from __future__ import annotations

from mycli.domain.dynamic_tools import (
    DynamicToolLifecycleEvent,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
)
from mycli.domain.tool_exposure import ToolExposure
from mycli.domain.tool_set import ToolSet
from mycli.domain.tools import ToolCall
from mycli.services.dynamic_tool_registry import DynamicToolRegistry
from mycli.infrastructure.models.base import ModelToolDefinition, ModelToolParameter
from mycli.tools.base import ToolResultV2
from mycli.tools.registry import ToolRegistryV2


class ToolRouter:
    def __init__(
        self,
        *,
        tool_registry: ToolRegistryV2,
        dynamic_tools: dict[str, DynamicToolRegistration] | None = None,
        dynamic_tool_registry: DynamicToolRegistry | None = None,
    ) -> None:
        self._tool_registry = tool_registry
        self._dynamic_tools = {} if dynamic_tools is None else dict(dynamic_tools)
        self._dynamic_tool_registry = dynamic_tool_registry
        self._lifecycle_events: list[DynamicToolLifecycleEvent] = []

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

    def execute(self, call: ToolCall, *, exposure: ToolExposure) -> ToolResultV2:
        allowed_names = set(exposure.callable_tool_names())
        if call.name not in allowed_names:
            rendered = ", ".join(sorted(allowed_names)) or "none"
            raise ValueError(
                f"Tool '{call.name}' is not exposed for this turn. Callable tools: {rendered}."
            )
        dynamic_tool = self._dynamic_tools.get(call.name)
        if dynamic_tool is not None:
            self._record_dynamic_transition(
                dynamic_tool.descriptor.tool_id,
                DynamicToolLifecycleState.INVOKED,
            )
            try:
                result = dynamic_tool.tool.execute(call.arguments)
            except Exception:
                self._record_dynamic_transition(
                    dynamic_tool.descriptor.tool_id,
                    DynamicToolLifecycleState.FAILED,
                )
                raise
            self._record_dynamic_transition(
                dynamic_tool.descriptor.tool_id,
                DynamicToolLifecycleState.COMPLETED,
            )
            return result
        return self._tool_registry.execute(call)

    def pop_lifecycle_events(self) -> tuple[DynamicToolLifecycleEvent, ...]:
        events = tuple(self._lifecycle_events)
        self._lifecycle_events.clear()
        return events

    def _record_dynamic_transition(
        self,
        tool_id: str,
        state: DynamicToolLifecycleState,
    ) -> None:
        if self._dynamic_tool_registry is None:
            return
        event = self._dynamic_tool_registry.transition(tool_id, state)
        if event is not None:
            self._lifecycle_events.append(event)

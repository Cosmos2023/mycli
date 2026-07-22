from __future__ import annotations

from mycli.domain.tooling.contributed_tools import (
    ToolContributionLifecycleEvent,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
)
from mycli.domain.tooling.exposure import ToolExposure
from mycli.domain.tooling.names import provider_safe_tool_name
from mycli.domain.tooling.tool_set import ToolSet
from mycli.domain.tooling.calls import ToolCall
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.llms.adapters.base import ModelToolDefinition, ModelToolParameter
from mycli.tools.base import (
    ToolEffectProfile,
    ToolResult,
    mutation_targets_for_tool,
    tool_effects_for_tool,
    tool_has_mutation_contract,
)
from mycli.tools.invocation_context import ToolInvocationContext, tool_invocation_scope
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

    def execute(
        self,
        call: ToolCall,
        *,
        exposure: ToolExposure,
        invocation_context: ToolInvocationContext | None = None,
    ) -> ToolResult:
        with tool_invocation_scope(invocation_context):
            return self._execute_scoped(call, exposure=exposure)

    def _execute_scoped(self, call: ToolCall, *, exposure: ToolExposure) -> ToolResult:
        call = self._canonical_call(call, exposure=exposure)
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

    def mutation_targets(
        self,
        call: ToolCall,
        *,
        exposure: ToolExposure,
    ) -> tuple[str, ...] | None:
        call = self._canonical_call(call, exposure=exposure)
        allowed_names = set(exposure.callable_tool_names())
        if call.name not in allowed_names:
            rendered = ", ".join(sorted(allowed_names)) or "none"
            raise ValueError(
                f"Tool '{call.name}' is not exposed for this turn. Callable tools: {rendered}."
            )
        contributed_tool = self._contributed_tools.get(call.name)
        if contributed_tool is not None:
            tool = contributed_tool.tool
            if not tool_has_mutation_contract(tool):
                return None
            return mutation_targets_for_tool(tool, call.arguments)
        return self._tool_registry.mutation_targets(call)

    def effect_profile(
        self,
        call: ToolCall,
        *,
        exposure: ToolExposure,
    ) -> ToolEffectProfile:
        call = self._canonical_call(call, exposure=exposure)
        allowed_names = set(exposure.callable_tool_names())
        if call.name not in allowed_names:
            rendered = ", ".join(sorted(allowed_names)) or "none"
            raise ValueError(
                f"Tool '{call.name}' is not exposed for this turn. Callable tools: {rendered}."
            )
        contributed_tool = self._contributed_tools.get(call.name)
        if contributed_tool is not None:
            return tool_effects_for_tool(contributed_tool.tool)
        return self._tool_registry.effect_profile(call)

    def supports_parallel_tool_calls(
        self,
        call: ToolCall,
        *,
        exposure: ToolExposure,
    ) -> bool:
        call = self._canonical_call(call, exposure=exposure)
        allowed_names = set(exposure.callable_tool_names())
        if call.name not in allowed_names:
            rendered = ", ".join(sorted(allowed_names)) or "none"
            raise ValueError(
                f"Tool '{call.name}' is not exposed for this turn. Callable tools: {rendered}."
            )
        contributed_tool = self._contributed_tools.get(call.name)
        if contributed_tool is not None:
            return contributed_tool.descriptor.spec.supports_parallel_tool_calls
        return self._tool_registry.supports_parallel_tool_calls(call.name)

    def _canonical_call(self, call: ToolCall, *, exposure: ToolExposure) -> ToolCall:
        if call.name in exposure.callable_tool_names():
            return call
        canonical_name = _legacy_contributed_tool_name(call.name)
        if canonical_name == call.name or canonical_name not in exposure.callable_tool_names():
            return call
        return ToolCall(
            name=canonical_name,
            arguments=call.arguments,
            reason=call.reason,
            call_id=call.call_id,
        )

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


def _legacy_contributed_tool_name(name: str) -> str:
    if name.startswith("skill."):
        return provider_safe_tool_name("skill", name.removeprefix("skill."))
    if name.startswith("subagent."):
        return provider_safe_tool_name("subagent", name.removeprefix("subagent."))
    return name

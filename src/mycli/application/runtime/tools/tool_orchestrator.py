from __future__ import annotations

from typing import Callable

from mycli.domain.capabilities import CapabilityActivation
from mycli.domain.conversation import Conversation
from mycli.domain.tooling.contributed_tools import (
    ToolContributionLifecycleEvent,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionSource,
)
from mycli.domain.runtime import ActivityEvent, PlanState, RuntimeTraceEvent, TurnItem, TurnItemType
from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolRouteSource,
)
from mycli.application.runtime.tools.contributed_tool_provider import ToolContributionProvider
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.tools.routing.tool_exposure_planner import PlannedToolExposure, ToolExposurePlanner
from mycli.tools.routing.tool_router import ToolRouter
from mycli.services.tracing import TraceService
from mycli.tools.registry import ToolRegistryV2


class ToolOrchestrator:
    """Plans model-visible tools and records runtime-only tool lifecycle events."""

    def __init__(
        self,
        *,
        session_id: str,
        tool_registry: ToolRegistryV2,
        tool_exposure_planner: ToolExposurePlanner,
        contributed_tool_registry: ToolContributionRegistry,
        contributed_tool_providers: tuple[ToolContributionProvider, ...],
        trace_service: TraceService,
        append_turn_item: Callable[..., None],
    ) -> None:
        self._session_id = session_id
        self._tool_registry = tool_registry
        self._tool_exposure_planner = tool_exposure_planner
        self._contributed_tool_registry = contributed_tool_registry
        self._contributed_tool_providers = tuple(contributed_tool_providers)
        self._trace_service = trace_service
        self._append_turn_item = append_turn_item

    def plan_tool_exposure(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations: tuple[CapabilityActivation, ...],
        runtime_contributed_tools: tuple[object, ...] | None = None,
    ) -> PlannedToolExposure:
        runtime_tools = (
            self._runtime_contributed_tools(
                user_message=user_message,
                conversation=conversation,
                plan_state=plan_state,
                capability_activations=capability_activations,
            )
            if runtime_contributed_tools is None
            else runtime_contributed_tools
        )
        planned = self._tool_exposure_planner.plan(
            user_message=user_message,
            capability_activations=capability_activations,
            runtime_contributed_tools=runtime_tools,
        )
        lifecycle_events: list[ToolContributionLifecycleEvent] = []

        for registration in planned.contributed_tools.values():
            result = self._contributed_tool_registry.register(registration)
            if result.lifecycle_event is not None:
                lifecycle_events.append(result.lifecycle_event)

        rebound_exposure, visible_tools = self._bind_visible_contributions(
            planned.exposure,
            planned.contributed_tools,
        )

        for registration in tuple(visible_tools.values()):
            if registration.descriptor.lifecycle_state is not ToolContributionLifecycleState.DECLARED:
                continue
            event = self._contributed_tool_registry.transition(
                registration.descriptor.tool_id,
                ToolContributionLifecycleState.EXPOSED,
            )
            if event is not None:
                lifecycle_events.append(event)

        rebound_exposure, visible_tools = self._bind_visible_contributions(
            planned.exposure,
            planned.contributed_tools,
        )
        return PlannedToolExposure(
            exposure=rebound_exposure,
            contributed_tools=visible_tools,
            lifecycle_events=tuple(lifecycle_events),
        )

    def build_tool_router(self, planned_exposure: PlannedToolExposure) -> ToolRouter:
        return ToolRouter(
            tool_registry=self._tool_registry,
            contributed_tools=planned_exposure.contributed_tools,
            contributed_tool_registry=self._contributed_tool_registry,
        )

    def append_tool_exposure_turn_item(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        tool_exposure: ToolExposure,
    ) -> None:
        summary = tool_exposure.summary()
        tool_names = sorted(summary["tools"])
        text = ", ".join(tool_names) or "none"
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.TOOL_EXPOSURE,
                text=text,
                metadata={"tool_names": tool_names},
            ),
        )
        activity_events.append(ActivityEvent(kind="tool_exposure", message=text))
        self._trace_service.append(
            self._session_id,
            RuntimeTraceEvent(
                kind="tool_exposure",
                turn_id=turn_id,
                payload={"tool_names": tool_names},
            ),
        )

    def append_tool_lifecycle_events(
        self,
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        activity_events: list[ActivityEvent],
        lifecycle_events: tuple[ToolContributionLifecycleEvent, ...],
    ) -> None:
        for event in lifecycle_events:
            text = (
                f"{event.route_name} "
                f"[scope={event.scope.value} state={event.state.value} source={event.source.value}]"
            )
            payload = event.to_dict()
            self._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.TOOL_EXPOSURE,
                    text=text,
                    tool_name=event.route_name,
                    metadata=payload,
                ),
            )
            activity_events.append(
                ActivityEvent(
                    kind="tool_lifecycle",
                    message=text,
                    tool_name=event.route_name,
                    preview=event.state.value,
                )
            )
            self._trace_service.append(
                self._session_id,
                RuntimeTraceEvent(
                    kind="tool_lifecycle",
                    turn_id=turn_id,
                    payload=payload,
                ),
            )

    def snapshot(self) -> list[dict[str, object]]:
        return self._contributed_tool_registry.snapshot()

    def expire_turn_scoped(self) -> tuple[ToolContributionLifecycleEvent, ...]:
        return self._contributed_tool_registry.expire_turn_scoped()

    def _runtime_contributed_tools(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        plan_state: PlanState,
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> tuple[object, ...]:
        registrations: list[object] = []
        for provider in self._contributed_tool_providers:
            provided = provider.provide(
                user_message=user_message,
                conversation=conversation,
                plan_state=plan_state,
                capability_activations=capability_activations,
            )
            registrations.extend(provided)
        return tuple(registrations)

    def _bind_visible_contributions(
        self,
        exposure: ToolExposure,
        planned_contributions: dict[str, ToolContributionRegistration],
    ) -> tuple[ToolExposure, dict[str, ToolContributionRegistration]]:
        existing_names = {entry.name for entry in exposure.entries}
        visible_contributions: dict[str, ToolContributionRegistration] = dict(
            planned_contributions
        )
        contributed_entries: list[ToolExposureEntry] = []

        for registration in self._contributed_tool_registry.get_visible_registrations():
            route_name = registration.descriptor.route_name
            if route_name in existing_names:
                visible_contributions[route_name] = registration
                continue
            visible_contributions[route_name] = registration
            contributed_entries.append(self._contributed_tool_entry(registration))

        return (
            ToolExposure(
                entries=(*exposure.entries, *contributed_entries),
            ),
            visible_contributions,
        )

    def _contributed_tool_entry(
        self,
        registration: ToolContributionRegistration,
    ) -> ToolExposureEntry:
        descriptor = registration.descriptor
        metadata = {
            "tool_id": descriptor.tool_id,
            "scope": descriptor.scope.value,
            "state": descriptor.lifecycle_state.value,
        }
        metadata.update(descriptor.origin_metadata)
        return ToolExposureEntry(
            route_key=descriptor.route_key,
            source=self._contributed_tool_route_source(descriptor.source),
            spec=descriptor.spec,
            metadata=metadata,
        )

    def _contributed_tool_route_source(
        self,
        source: ToolContributionSource,
    ) -> ToolRouteSource:
        if source is ToolContributionSource.RUNTIME:
            return ToolRouteSource.RUNTIME
        if source is ToolContributionSource.CAPABILITY:
            return ToolRouteSource.CAPABILITY
        return ToolRouteSource.PROVIDER

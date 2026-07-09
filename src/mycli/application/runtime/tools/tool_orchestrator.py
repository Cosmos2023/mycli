from __future__ import annotations

from collections.abc import Callable, Collection
from typing import TypeVar

from mycli.application.runtime.tools.runtime_policy import RuntimePolicyGate
from mycli.application.runtime.tools.tool_file_history_runtime import ToolFileHistoryRuntime
from mycli.application.runtime.tools.tool_call_runtime import (
    OutcomeApplier,
    ToolBatchExecutor,
    ToolCallExecutor,
    ToolCallRuntime,
    AbortOutcomeFactory,
    SupportsParallelToolCall,
)
from mycli.application.runtime.tools.tool_hook_runtime import (
    PostToolHookResult,
    PreToolHookResult,
    ToolHookRuntime,
)
from mycli.application.runtime.tools.tool_policy_runtime import ToolPolicyRuntime
from mycli.application.runtime.tools.tool_write_diagnostics_runtime import (
    ToolWriteDiagnosticsRuntime,
    WriteDiagnosticsRunner,
)
from mycli.domain.conversation import Conversation
from mycli.domain.tooling.contributed_tools import (
    ToolContributionLifecycleEvent,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionSource,
)
from mycli.domain.runtime import (
    ActivityEvent,
    PlanState,
    RuntimeInterruptToken,
    RuntimeTraceEvent,
    ToolRuntimeDecision,
    TurnItem,
    TurnItemType,
)
from mycli.domain.tooling.calls import ToolCall
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
from mycli.services.hooks import HookManager
from mycli.services.file_history import FileHistoryService
from mycli.tools.base import ToolEffectProfile, ToolResult
from mycli.tools.registry import ToolRegistry

OutcomeT = TypeVar("OutcomeT")


class ToolRuntimeOrchestrator:
    """Coordinates runtime policy, hook, and result-shaping around tool execution."""

    def __init__(
        self,
        *,
        session_id: str,
        trace_service: TraceService,
        policy_gate: RuntimePolicyGate | None,
        hook_manager: HookManager,
        file_history: FileHistoryService | None = None,
        write_diagnostics_runner: WriteDiagnosticsRunner | None = None,
    ) -> None:
        self._policy_runtime = ToolPolicyRuntime(
            session_id=session_id,
            policy_gate=policy_gate,
            trace_service=trace_service,
        )
        self._hook_runtime = ToolHookRuntime(
            session_id=session_id,
            hook_manager=hook_manager,
        )
        self._file_history_runtime = ToolFileHistoryRuntime(
            session_id=session_id,
            file_history=file_history,
        )
        self._write_diagnostics_runtime = ToolWriteDiagnosticsRuntime(
            runner=write_diagnostics_runner,
        )

    def set_session_id(self, session_id: str) -> None:
        self._policy_runtime.session_id = session_id
        self._hook_runtime.set_session_id(session_id)
        self._file_history_runtime.set_session_id(session_id)

    def execute_tool_calls(
        self,
        *,
        calls: list[ToolCall] | tuple[ToolCall, ...],
        plan_state: PlanState,
        concurrency_safe_tools: Collection[str],
        supports_parallel_tool_call: SupportsParallelToolCall | None = None,
        execute_call: ToolCallExecutor[OutcomeT] | None = None,
        execute_batch: ToolBatchExecutor[OutcomeT] | None = None,
        apply_outcome: OutcomeApplier[OutcomeT] | None = None,
        abort_outcome: AbortOutcomeFactory[OutcomeT] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> PlanState:
        runtime: ToolCallRuntime[OutcomeT] = ToolCallRuntime(
            concurrency_safe_tools=concurrency_safe_tools,
            supports_parallel_tool_call=supports_parallel_tool_call,
            execute_call=execute_call,
            execute_batch=execute_batch,
            abort_outcome=abort_outcome,
            interrupt_token=interrupt_token,
        )
        return runtime.execute_calls(
            calls=calls,
            plan_state=plan_state,
            apply_outcome=apply_outcome,
        )

    def interrupted_tool_result(self, call: ToolCall) -> ToolResult:
        error = f"Tool {call.name} was interrupted before it completed."
        return ToolResult(
            success=False,
            summary=error,
            error=error,
            raw_payload={
                "tool_name": call.name,
                "arguments": dict(call.arguments),
                "error_kind": "tool_interrupted",
            },
        )

    def decide_policy(
        self,
        *,
        call: ToolCall,
        tool_exposure: ToolExposure,
        turn_id: str,
        policy_approved: bool,
        effect_profile: ToolEffectProfile,
    ) -> ToolRuntimeDecision | None:
        return self._policy_runtime.decide(
            call=call,
            tool_exposure=tool_exposure,
            turn_id=turn_id,
            policy_approved=policy_approved,
            effect_profile=effect_profile,
        )

    def policy_result(self, decision: ToolRuntimeDecision) -> ToolResult:
        return self._policy_runtime.result_for_decision(decision)

    def before_tool_use(self, *, call: ToolCall, turn_id: str) -> PreToolHookResult:
        return self._hook_runtime.before_tool_use(call=call, turn_id=turn_id)

    def snapshot_before_file_mutation(
        self,
        *,
        call: ToolCall,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        turn_id: str,
        turn_metadata: dict[str, object],
    ) -> list[str]:
        return self._file_history_runtime.snapshot_before_file_mutation(
            call=call,
            tool_router=tool_router,
            tool_exposure=tool_exposure,
            turn_id=turn_id,
            turn_metadata=turn_metadata,
        )

    def finalize_file_history_snapshots(
        self,
        *,
        snapshot_ids: list[str],
        result: ToolResult,
        turn_metadata: dict[str, object],
    ) -> None:
        self._file_history_runtime.finalize_file_history_snapshots(
            snapshot_ids=snapshot_ids,
            result=result,
            turn_metadata=turn_metadata,
        )

    def after_tool_use(
        self,
        *,
        call: ToolCall,
        turn_id: str,
        result: ToolResult,
    ) -> PostToolHookResult:
        return self._hook_runtime.after_tool_use(
            call=call,
            turn_id=turn_id,
            result=result,
        )

    def with_write_diagnostics_if_needed(
        self,
        *,
        call: ToolCall,
        result: ToolResult,
        effect_profile: ToolEffectProfile,
    ) -> ToolResult:
        return self._write_diagnostics_runtime.with_write_diagnostics_if_needed(
            call=call,
            result=result,
            effect_profile=effect_profile,
        )


class ToolOrchestrator:
    """Plans model-visible tools and records runtime-only tool lifecycle events."""

    def __init__(
        self,
        *,
        session_id: str,
        tool_registry: ToolRegistry,
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
        runtime_contributed_tools: tuple[object, ...] | None = None,
    ) -> PlannedToolExposure:
        runtime_tools = (
            self._runtime_contributed_tools(
                user_message=user_message,
                conversation=conversation,
                plan_state=plan_state,
            )
            if runtime_contributed_tools is None
            else runtime_contributed_tools
        )
        planned = self._tool_exposure_planner.plan(
            user_message=user_message,
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
    ) -> tuple[object, ...]:
        registrations: list[object] = []
        for provider in self._contributed_tool_providers:
            provided = provider.provide(
                user_message=user_message,
                conversation=conversation,
                plan_state=plan_state,
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
        return ToolRouteSource.PROVIDER

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from time import monotonic

from mycli.application.runtime.tools.tool_file_history_runtime import (
    FILE_MUTATION_TOOLS,
)
from mycli.application.runtime.tools.tool_orchestrator import ToolRuntimeOrchestrator
from mycli.application.runtime.tools.tool_write_diagnostics_runtime import (
    WriteDiagnosticsRunner,
)
from mycli.application.runtime.tools.runtime_policy import RuntimePolicyGate
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    ActivityEvent,
    InvokedSkillSnapshot,
    PendingClarification,
    PlanItem,
    PlanState,
    PlanStatus,
    RuntimeBlock,
    RuntimeInterruptToken,
    RuntimeStreamEvent,
    RuntimeTraceEvent,
    ToolRuntimeDecisionKind,
    TurnItem,
    TurnItemType,
)
from mycli.domain.tooling.calls import ToolCall, ToolEvidence
from mycli.domain.tooling.exposure import ToolExposure
from mycli.domain.tooling.output import (
    ToolImageContent,
    ToolJsonContent,
    ToolModelOutput,
)
from mycli.schemas.responses_protocol import (
    ResponsesFunctionCallOutputImageItem,
    ResponsesFunctionCallOutputPayload,
    ResponsesFunctionCallOutputTextItem,
)
from mycli.services.context.context_manager import ContextManager
from mycli.services.context.tool_output_projector import (
    ToolModelOutputProjector,
    legacy_runtime_tool_result_text,
)
from mycli.services.file_history import FileHistoryService
from mycli.services.hooks import HookExecutionSummary, HookManager
from mycli.services.security import InjectionGuard
from mycli.services.tool_display import ToolDisplayEnvelope, ToolDisplayProjector
from mycli.services.tracing import TraceService
from mycli.tools.base import ToolEffectProfile, ToolResult
from mycli.tools.routing.tool_router import ToolRouter

SHELL_TOOL_NAMES = frozenset({"Shell", "Bash", "run_shell"})
ToolLifecycleSink = Callable[[RuntimeStreamEvent], None]
MAX_LIFECYCLE_PREVIEW_CHARS = 160
MAX_LIFECYCLE_CONTENT_PREVIEW_CHARS = 12_000
MAX_LIFECYCLE_DIFF_PREVIEW_CHARS = 12_000
MAX_CLARIFY_OPTIONS = 5
_DENIED_ERROR_KINDS = frozenset(
    {
        "tool_denied_by_hook",
        "tool_denied_by_policy",
        "tool_denied_by_post_hook",
    }
)


@dataclass(slots=True, frozen=True)
class _ParallelToolOutcome:
    plan_state: PlanState
    messages: tuple[Message, ...]
    activity_events: tuple[ActivityEvent, ...]
    turn_items: tuple[TurnItem, ...]


class ToolExecutionService:
    """Executes tools while keeping provider transcript and UI events separate."""

    def __init__(
        self,
        *,
        session_id: str,
        context_manager: ContextManager,
        trace_service: TraceService,
        append_turn_item: Callable[..., None],
        append_lifecycle_events: Callable[..., None],
        apply_tool_effects: Callable[..., PlanState],
        normalize_tool_call: Callable[[ToolCall], ToolCall],
        hook_manager: HookManager | None = None,
        file_history: FileHistoryService | None = None,
        injection_guard: InjectionGuard | None = None,
        record_invoked_skill: Callable[[InvokedSkillSnapshot], None] | None = None,
        write_diagnostics_runner: WriteDiagnosticsRunner | None = None,
        policy_gate: RuntimePolicyGate | None = None,
        tool_display_projector: ToolDisplayProjector | None = None,
        tool_model_output_projector: ToolModelOutputProjector | None = None,
    ) -> None:
        self._session_id = session_id
        self._context_manager = context_manager
        self._trace_service = trace_service
        self._append_turn_item = append_turn_item
        self._append_lifecycle_events = append_lifecycle_events
        self._apply_tool_effects = apply_tool_effects
        self._normalize_tool_call = normalize_tool_call
        self._hook_manager = hook_manager or HookManager()
        self._injection_guard = injection_guard or InjectionGuard()
        self._record_invoked_skill = record_invoked_skill
        self._policy_gate = policy_gate
        self._tool_display_projector = tool_display_projector or ToolDisplayProjector()
        self._tool_model_output_projector = (
            tool_model_output_projector
            or ToolModelOutputProjector(
                legacy_renderer=lambda _tool_name, result: (
                    legacy_runtime_tool_result_text(result)
                )
            )
        )
        self._runtime_orchestrator = ToolRuntimeOrchestrator(
            session_id=session_id,
            trace_service=trace_service,
            policy_gate=policy_gate,
            hook_manager=self._hook_manager,
            file_history=file_history,
            write_diagnostics_runner=write_diagnostics_runner,
        )
        self._monotonic = monotonic

    def set_session_id(self, session_id: str) -> None:
        self._session_id = session_id
        self._runtime_orchestrator.set_session_id(session_id)

    def execute_tool_calls(
        self,
        *,
        conversation: Conversation,
        calls: list[ToolCall] | tuple[ToolCall, ...],
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
        provider_id: str | None = None,
        response_id: str | None = None,
        metadata: dict[str, object] | None = None,
        record_assistant_call: bool = True,
        lifecycle_sink: ToolLifecycleSink | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> PlanState:
        def execute_call(
            call: ToolCall,
            batch_plan_state: PlanState,
        ) -> _ParallelToolOutcome:
            return self._execute_tool_call_isolated(
                call=call,
                tool_router=tool_router,
                tool_exposure=tool_exposure,
                plan_state=batch_plan_state,
                turn_id=turn_id,
                provider_id=provider_id,
                response_id=response_id,
                metadata=metadata,
                record_assistant_call=record_assistant_call,
                lifecycle_sink=lifecycle_sink,
                interrupt_token=interrupt_token,
            )

        def apply_outcome(outcome: _ParallelToolOutcome) -> PlanState:
            conversation.messages.extend(outcome.messages)
            activity_events.extend(outcome.activity_events)
            turn_items.extend(outcome.turn_items)
            return outcome.plan_state

        def abort_outcome(
            call: ToolCall,
            batch_plan_state: PlanState,
        ) -> _ParallelToolOutcome:
            return self._record_aborted_tool_call_isolated(
                call=call,
                tool_router=tool_router,
                tool_exposure=tool_exposure,
                plan_state=batch_plan_state,
                turn_id=turn_id,
                provider_id=provider_id,
                response_id=response_id,
                metadata=metadata,
                record_assistant_call=record_assistant_call,
                lifecycle_sink=lifecycle_sink,
            )

        return self._runtime_orchestrator.execute_tool_calls(
            calls=calls,
            plan_state=plan_state,
            concurrency_safe_tools=frozenset(),
            supports_parallel_tool_call=lambda call: tool_router.supports_parallel_tool_calls(
                call,
                exposure=tool_exposure,
            ),
            execute_call=execute_call,
            apply_outcome=apply_outcome,
            abort_outcome=abort_outcome,
            interrupt_token=interrupt_token,
        )

    def execute_tool_call(
        self,
        *,
        conversation: Conversation,
        call: ToolCall,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
        provider_id: str | None = None,
        response_id: str | None = None,
        metadata: dict[str, object] | None = None,
        record_assistant_call: bool = True,
        lifecycle_sink: ToolLifecycleSink | None = None,
        policy_approved: bool = False,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> PlanState:
        _raise_if_interrupted(interrupt_token)
        normalized_call = self._normalize_tool_call(call)
        execution_started_at = self._monotonic()
        self._append_tool_runtime_lifecycle_trace(
            turn_id=turn_id,
            call=normalized_call,
            phase="planned",
            status="running",
        )
        effect_profile = self._effect_profile_for_call(
            call=normalized_call,
            tool_router=tool_router,
            tool_exposure=tool_exposure,
        )
        runtime_decision = self._runtime_orchestrator.decide_policy(
            call=normalized_call,
            tool_exposure=tool_exposure,
            turn_id=turn_id,
            policy_approved=policy_approved,
            effect_profile=effect_profile,
        )
        if runtime_decision is not None:
            self._append_tool_runtime_lifecycle_trace(
                turn_id=turn_id,
                call=normalized_call,
                phase="policy_checked",
                status="running",
                policy_decision=runtime_decision.kind.value,
            )
        if runtime_decision is not None and runtime_decision.kind is not ToolRuntimeDecisionKind.ALLOWED:
            self._record_tool_start(
                normalized_call=normalized_call,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                metadata=metadata,
                provider_id=provider_id,
                lifecycle_sink=lifecycle_sink,
            )
            policy_result = self._runtime_orchestrator.policy_result(runtime_decision)
            return self._record_tool_outcome(
                conversation=conversation,
                normalized_call=normalized_call,
                result=policy_result,
                plan_state=plan_state,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                metadata=metadata,
                provider_id=provider_id,
                response_id=response_id,
                record_assistant_call=record_assistant_call,
                execution_started_at=execution_started_at,
                effect_profile=effect_profile,
                lifecycle_sink=lifecycle_sink,
                emit_runtime_progress=False,
            )
        pre_hook_result = self._runtime_orchestrator.before_tool_use(
            call=normalized_call,
            turn_id=turn_id,
        )
        normalized_call = pre_hook_result.call
        pre_hook_summaries = pre_hook_result.summaries
        if pre_hook_result.denied_result is not None:
            self._record_tool_start(
                normalized_call=normalized_call,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                metadata=metadata,
                provider_id=provider_id,
                lifecycle_sink=lifecycle_sink,
            )
            return self._record_tool_outcome(
                conversation=conversation,
                normalized_call=normalized_call,
                result=pre_hook_result.denied_result,
                plan_state=plan_state,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                metadata=metadata,
                provider_id=provider_id,
                response_id=response_id,
                record_assistant_call=record_assistant_call,
                execution_started_at=execution_started_at,
                effect_profile=effect_profile,
                hook_summaries=pre_hook_summaries,
                lifecycle_sink=lifecycle_sink,
                emit_runtime_progress=False,
            )
        turn_metadata = dict(metadata or {})
        turn_metadata["arguments"] = normalized_call.arguments
        turn_metadata["provider_id"] = provider_id
        turn_metadata["display"] = self._tool_display_projector.project_start(
            normalized_call
        ).to_dict()
        self._record_tool_start(
            normalized_call=normalized_call,
            turn_id=turn_id,
            activity_events=activity_events,
            turn_items=turn_items,
            metadata=metadata,
            provider_id=provider_id,
            lifecycle_sink=lifecycle_sink,
        )
        _raise_if_interrupted(interrupt_token)
        if record_assistant_call:
            self._record_assistant_tool_call(
                conversation,
                tool_call=normalized_call,
                provider_id=provider_id,
                response_id=response_id,
                metadata=metadata,
            )
        execution_call = self._with_runtime_execution_options(
            normalized_call,
            interrupt_token=interrupt_token,
        )
        snapshot_ids = self._runtime_orchestrator.snapshot_before_file_mutation(
            call=normalized_call,
            tool_router=tool_router,
            tool_exposure=tool_exposure,
            turn_id=turn_id,
            turn_metadata=turn_metadata,
        )
        try:
            _raise_if_interrupted(interrupt_token)
            result = tool_router.execute(execution_call, exposure=tool_exposure)
            _raise_if_interrupted(interrupt_token)
        except KeyboardInterrupt:
            interrupted_result = self._interrupted_tool_result(normalized_call)
            self._runtime_orchestrator.finalize_file_history_snapshots(
                snapshot_ids=snapshot_ids,
                result=interrupted_result,
                turn_metadata=turn_metadata,
            )
            self._record_tool_outcome(
                conversation=conversation,
                normalized_call=normalized_call,
                result=interrupted_result,
                plan_state=plan_state,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                metadata=metadata,
                provider_id=provider_id,
                response_id=response_id,
                record_assistant_call=False,
                execution_started_at=execution_started_at,
                effect_profile=effect_profile,
                hook_summaries=pre_hook_summaries,
                lifecycle_sink=lifecycle_sink,
            )
            raise
        except ValueError as exc:
            result = ToolResult(
                success=False,
                summary=f"Tool {normalized_call.name} could not run because its arguments were invalid.",
                error=str(exc),
                raw_payload={
                    "tool_name": normalized_call.name,
                    "arguments": dict(normalized_call.arguments),
                    "path": _tool_call_path(normalized_call),
                    "error_kind": "tool_validation_error",
                },
            )
        self._runtime_orchestrator.finalize_file_history_snapshots(
            snapshot_ids=snapshot_ids,
            result=result,
            turn_metadata=turn_metadata,
        )
        result = self._runtime_orchestrator.with_write_diagnostics_if_needed(
            call=normalized_call,
            result=result,
            effect_profile=effect_profile,
        )
        try:
            return self._record_tool_outcome(
                conversation=conversation,
                normalized_call=normalized_call,
                result=result,
                plan_state=plan_state,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                metadata=metadata,
                provider_id=provider_id,
                response_id=response_id,
                record_assistant_call=False,
                execution_started_at=execution_started_at,
                effect_profile=effect_profile,
                hook_summaries=pre_hook_summaries,
                lifecycle_sink=lifecycle_sink,
            )
        finally:
            lifecycle_events = tool_router.pop_lifecycle_events()
            if lifecycle_events:
                self._append_lifecycle_events(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    activity_events=activity_events,
                    lifecycle_events=lifecycle_events,
                )

    def execute_tool_call_for_clarification(
        self,
        *,
        conversation: Conversation,
        call: ToolCall,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
        provider_id: str | None = None,
        response_id: str | None = None,
        metadata: dict[str, object] | None = None,
        lifecycle_sink: ToolLifecycleSink | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> tuple[PlanState, PendingClarification | None]:
        _raise_if_interrupted(interrupt_token)
        normalized_call = self._normalize_tool_call(call)
        execution_started_at = self._monotonic()
        self._append_tool_runtime_lifecycle_trace(
            turn_id=turn_id,
            call=normalized_call,
            phase="planned",
            status="running",
        )
        effect_profile = self._effect_profile_for_call(
            call=normalized_call,
            tool_router=tool_router,
            tool_exposure=tool_exposure,
        )
        turn_metadata = dict(metadata or {})
        turn_metadata["arguments"] = normalized_call.arguments
        turn_metadata["provider_id"] = provider_id
        turn_metadata["display"] = self._tool_display_projector.project_start(
            normalized_call
        ).to_dict()
        start_event = self._tool_activity_event(normalized_call, phase="start")
        activity_events.append(start_event)
        self._notify_lifecycle_sink(
            lifecycle_sink,
            self._tool_lifecycle_start_event(call=normalized_call, context=start_event.message),
        )
        self._append_tool_runtime_lifecycle_trace(
            turn_id=turn_id,
            call=normalized_call,
            phase="started",
            status="running",
        )
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.TOOL_CALL,
                text=start_event.message,
                tool_name=normalized_call.name,
                call_id=normalized_call.call_id,
                metadata=turn_metadata,
            ),
        )
        try:
            _raise_if_interrupted(interrupt_token)
            result = tool_router.execute(normalized_call, exposure=tool_exposure)
            _raise_if_interrupted(interrupt_token)
        except KeyboardInterrupt:
            interrupted_result = self._interrupted_tool_result(normalized_call)
            self._record_tool_outcome(
                conversation=conversation,
                normalized_call=normalized_call,
                result=interrupted_result,
                plan_state=plan_state,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                metadata=metadata,
                provider_id=provider_id,
                response_id=response_id,
                record_assistant_call=False,
                execution_started_at=execution_started_at,
                effect_profile=effect_profile,
                lifecycle_sink=lifecycle_sink,
            )
            raise
        except ValueError as exc:
            result = ToolResult(
                success=False,
                summary=f"Tool {normalized_call.name} could not run because its arguments were invalid.",
                error=str(exc),
                raw_payload={
                    "tool_name": normalized_call.name,
                    "arguments": dict(normalized_call.arguments),
                    "path": _tool_call_path(normalized_call),
                    "error_kind": "tool_validation_error",
                },
            )
        pending_clarification = self.pending_clarification_from_result(
            call=normalized_call,
            result=result,
        )
        if pending_clarification is None:
            next_plan_state = self._record_tool_outcome(
                conversation=conversation,
                normalized_call=normalized_call,
                result=result,
                plan_state=plan_state,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                metadata=metadata,
                provider_id=provider_id,
                response_id=response_id,
                record_assistant_call=False,
                execution_started_at=execution_started_at,
                effect_profile=effect_profile,
                lifecycle_sink=lifecycle_sink,
            )
            return next_plan_state, None
        self._notify_lifecycle_sink(
            lifecycle_sink,
            self._tool_lifecycle_progress_event(call=normalized_call),
        )
        self._append_tool_runtime_lifecycle_trace(
            turn_id=turn_id,
            call=normalized_call,
            phase="progress",
            status="running",
        )
        activity_events.append(
            self._tool_activity_event(
                normalized_call,
                phase="finish",
                result_summary=result.summary,
            )
        )
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.CLARIFICATION_REQUEST,
                text=pending_clarification.question,
                tool_name=normalized_call.name,
                call_id=normalized_call.call_id,
                metadata={
                    "request_id": pending_clarification.request_id,
                    "question": pending_clarification.question,
                    "options": list(pending_clarification.options),
                    "header": pending_clarification.header,
                    "multi_select": pending_clarification.multi_select,
                },
            ),
        )
        duration_seconds = max(0.0, self._monotonic() - execution_started_at)
        self._notify_lifecycle_sink(
            lifecycle_sink,
            self._tool_lifecycle_finish_event(
                call=normalized_call,
                result=result,
                duration_seconds=duration_seconds,
            ),
        )
        self._append_tool_runtime_lifecycle_trace(
            turn_id=turn_id,
            call=normalized_call,
            phase="needs_approval",
            status="needs_approval",
            duration_seconds=duration_seconds,
        )
        clarify_event = self._clarify_request_event(call=normalized_call, result=result)
        if clarify_event is not None:
            self._notify_lifecycle_sink(lifecycle_sink, clarify_event)
        return plan_state, pending_clarification

    def _execute_tool_call_isolated(
        self,
        *,
        call: ToolCall,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        provider_id: str | None,
        response_id: str | None,
        metadata: dict[str, object] | None,
        record_assistant_call: bool,
        lifecycle_sink: ToolLifecycleSink | None,
        policy_approved: bool = False,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> _ParallelToolOutcome:
        _raise_if_interrupted(interrupt_token)
        isolated_conversation = Conversation(session_id=self._session_id)
        isolated_activity_events: list[ActivityEvent] = []
        isolated_turn_items: list[TurnItem] = []
        next_plan_state = self.execute_tool_call(
            conversation=isolated_conversation,
            call=call,
            tool_router=tool_router,
            tool_exposure=tool_exposure,
            plan_state=plan_state,
            turn_id=turn_id,
            activity_events=isolated_activity_events,
            turn_items=isolated_turn_items,
            provider_id=provider_id,
            response_id=response_id,
            metadata=metadata,
            record_assistant_call=record_assistant_call,
            lifecycle_sink=lifecycle_sink,
            policy_approved=policy_approved,
            interrupt_token=interrupt_token,
        )
        return _ParallelToolOutcome(
            plan_state=next_plan_state,
            messages=tuple(isolated_conversation.messages),
            activity_events=tuple(isolated_activity_events),
            turn_items=tuple(isolated_turn_items),
        )

    def _record_aborted_tool_call_isolated(
        self,
        *,
        call: ToolCall,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        provider_id: str | None,
        response_id: str | None,
        metadata: dict[str, object] | None,
        record_assistant_call: bool,
        lifecycle_sink: ToolLifecycleSink | None,
    ) -> _ParallelToolOutcome:
        isolated_conversation = Conversation(session_id=self._session_id)
        isolated_activity_events: list[ActivityEvent] = []
        isolated_turn_items: list[TurnItem] = []
        normalized_call = self._normalize_tool_call(call)
        execution_started_at = self._monotonic()
        self._append_tool_runtime_lifecycle_trace(
            turn_id=turn_id,
            call=normalized_call,
            phase="planned",
            status="running",
        )
        effect_profile = self._effect_profile_for_call(
            call=normalized_call,
            tool_router=tool_router,
            tool_exposure=tool_exposure,
        )
        self._record_tool_start(
            normalized_call=normalized_call,
            turn_id=turn_id,
            activity_events=isolated_activity_events,
            turn_items=isolated_turn_items,
            metadata=metadata,
            provider_id=provider_id,
            lifecycle_sink=lifecycle_sink,
        )
        next_plan_state = self._record_tool_outcome(
            conversation=isolated_conversation,
            normalized_call=normalized_call,
            result=self._runtime_orchestrator.interrupted_tool_result(normalized_call),
            plan_state=plan_state,
            turn_id=turn_id,
            activity_events=isolated_activity_events,
            turn_items=isolated_turn_items,
            metadata=metadata,
            provider_id=provider_id,
            response_id=response_id,
            record_assistant_call=record_assistant_call,
            execution_started_at=execution_started_at,
            effect_profile=effect_profile,
            lifecycle_sink=lifecycle_sink,
        )
        return _ParallelToolOutcome(
            plan_state=next_plan_state,
            messages=tuple(isolated_conversation.messages),
            activity_events=tuple(isolated_activity_events),
            turn_items=tuple(isolated_turn_items),
        )

    def _record_tool_outcome(
        self,
        *,
        conversation: Conversation,
        normalized_call: ToolCall,
        result: ToolResult,
        plan_state: PlanState,
        turn_id: str,
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
        metadata: dict[str, object] | None,
        provider_id: str | None,
        response_id: str | None,
        record_assistant_call: bool,
        execution_started_at: float,
        effect_profile: ToolEffectProfile,
        hook_summaries: tuple[HookExecutionSummary, ...] = (),
        lifecycle_sink: ToolLifecycleSink | None = None,
        emit_runtime_progress: bool = True,
    ) -> PlanState:
        self._notify_lifecycle_sink(
            lifecycle_sink,
            self._tool_lifecycle_progress_event(call=normalized_call),
        )
        if emit_runtime_progress:
            self._append_tool_runtime_lifecycle_trace(
                turn_id=turn_id,
                call=normalized_call,
                phase="progress",
                status="running",
            )
        if record_assistant_call:
            self._record_assistant_tool_call(
                conversation,
                tool_call=normalized_call,
                provider_id=provider_id,
                response_id=response_id,
                metadata=metadata,
            )
        post_hook_result = self._runtime_orchestrator.after_tool_use(
            call=normalized_call,
            turn_id=turn_id,
            result=result,
        )
        combined_hook_summaries = (*hook_summaries, *post_hook_result.summaries)
        result = post_hook_result.result
        post_tool_contexts = post_hook_result.additional_contexts
        next_plan_state = self._apply_tool_effects(
            call=normalized_call,
            result_payload=result.raw_payload,
            plan_state=plan_state,
        )
        if next_plan_state != plan_state:
            plan_update_metadata = _plan_update_metadata(
                next_plan_state,
                source=normalized_call.name,
            )
            self._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.PLAN_UPDATE,
                    text="Updated Plan",
                    metadata=plan_update_metadata,
                ),
            )
            self._notify_lifecycle_sink(
                lifecycle_sink,
                RuntimeStreamEvent(
                    kind="plan_updated",
                    metadata=_live_plan_update_payload(
                        next_plan_state,
                        metadata=plan_update_metadata,
                    ),
                ),
            )
        model_output = self._tool_model_output_projector.project(
            normalized_call.name,
            result,
        )
        tool_transcript_content = model_output.text_content()
        guarded_tool_transcript_content = (
            tool_transcript_content
            if normalized_call.name == "Skill"
            else self._injection_guard.guard_tool_output(tool_transcript_content)
        )
        function_call_output_payload = self._function_call_output_payload(
            model_output,
            guarded_text=guarded_tool_transcript_content,
        )
        self._record_tool_message(
            conversation,
            tool_name=normalized_call.name,
            content=guarded_tool_transcript_content,
            success=result.success,
            summary=result.summary,
            error=result.error,
            raw_payload=result.raw_payload,
            evidence=result.evidence,
            tool_call_id=normalized_call.call_id,
            post_tool_contexts=post_tool_contexts,
            function_call_output_payload=function_call_output_payload,
        )
        self._record_skill_instruction_message(
            conversation,
            tool_name=normalized_call.name,
            result=result,
            turn_id=turn_id,
            turn_items=turn_items,
        )
        self._record_skill_invocation(
            tool_name=normalized_call.name,
            result=result,
            turn_id=turn_id,
            call_id=normalized_call.call_id,
        )
        finish_event = self._tool_activity_event(
            normalized_call,
            phase="finish",
            result_summary=result.summary,
        )
        duration_seconds = max(0.0, self._monotonic() - execution_started_at)
        result_display = self._tool_display_projector.project_result(
            normalized_call,
            result,
            duration_ms=round(duration_seconds * 1000),
        )
        result_metadata: dict[str, object] = {
            "success": result.success,
            "summary": result.summary,
            "error": result.error,
            "path": result.raw_payload.get("path"),
            "error_kind": result.raw_payload.get("error_kind"),
            "raw_payload": dict(result.raw_payload),
            "transcript_content": guarded_tool_transcript_content,
            "file_changes": [
                change.to_dict() for change in result_display.file_changes
            ],
            "display": result_display.to_dict(),
        }
        diff = result.raw_payload.get("diff")
        if isinstance(diff, str) and diff:
            result_metadata["diff"] = diff
        write_diagnostics = result.raw_payload.get("write_diagnostics")
        if isinstance(write_diagnostics, dict):
            result_metadata["write_diagnostics"] = write_diagnostics
        activity_events.append(finish_event)
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.TOOL_RESULT,
                text=finish_event.message,
                tool_name=normalized_call.name,
                call_id=normalized_call.call_id,
                metadata=result_metadata,
            ),
        )
        self._notify_lifecycle_sink(
            lifecycle_sink,
            self._tool_lifecycle_finish_event(
                call=normalized_call,
                result=result,
                duration_seconds=duration_seconds,
                display=result_display,
            ),
        )
        terminal_phase = self._tool_runtime_terminal_phase(result)
        self._append_tool_runtime_lifecycle_trace(
            turn_id=turn_id,
            call=normalized_call,
            phase=terminal_phase,
            status=terminal_phase,
            duration_seconds=duration_seconds,
            error_kind=result.raw_payload.get("error_kind"),
            result=result,
        )
        clarify_event = self._clarify_request_event(call=normalized_call, result=result)
        if clarify_event is not None:
            self._notify_lifecycle_sink(lifecycle_sink, clarify_event)
        self._trace_service.append(
            self._session_id,
            RuntimeTraceEvent(
                kind="tool_execution",
                turn_id=turn_id,
                payload=self._tool_execution_trace_payload(
                    call=normalized_call,
                    result=result,
                    duration_seconds=duration_seconds,
                    effect_profile=effect_profile,
                    hook_summaries=combined_hook_summaries,
                ),
            ),
        )
        return next_plan_state

    def _with_runtime_execution_options(
        self,
        call: ToolCall,
        *,
        interrupt_token: RuntimeInterruptToken | None,
    ) -> ToolCall:
        if call.name not in SHELL_TOOL_NAMES:
            return call
        arguments = dict(call.arguments)
        if self._policy_gate is not None:
            arguments["_runtime_shell_options"] = self._policy_gate.shell_execution_options()
        if interrupt_token is not None:
            arguments["_runtime_interrupt_token"] = interrupt_token
        if call.call_id:
            arguments["_runtime_tool_call_id"] = call.call_id
        return ToolCall(
            name=call.name,
            arguments=arguments,
            reason=call.reason,
            call_id=call.call_id,
        )

    def _record_tool_start(
        self,
        *,
        normalized_call: ToolCall,
        turn_id: str,
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
        metadata: dict[str, object] | None,
        provider_id: str | None,
        lifecycle_sink: ToolLifecycleSink | None,
    ) -> None:
        turn_metadata = dict(metadata or {})
        turn_metadata["arguments"] = normalized_call.arguments
        turn_metadata["provider_id"] = provider_id
        turn_metadata["display"] = self._tool_display_projector.project_start(
            normalized_call
        ).to_dict()
        start_event = self._tool_activity_event(normalized_call, phase="start")
        activity_events.append(start_event)
        self._notify_lifecycle_sink(
            lifecycle_sink,
            self._tool_lifecycle_start_event(call=normalized_call, context=start_event.message),
        )
        self._append_tool_runtime_lifecycle_trace(
            turn_id=turn_id,
            call=normalized_call,
            phase="started",
            status="running",
        )
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.TOOL_CALL,
                text=start_event.message,
                tool_name=normalized_call.name,
                call_id=normalized_call.call_id,
                metadata=turn_metadata,
            ),
        )

    def _notify_lifecycle_sink(
        self,
        sink: ToolLifecycleSink | None,
        event: RuntimeStreamEvent,
    ) -> None:
        if sink is None:
            return
        try:
            sink(event)
        except Exception:
            return

    def _tool_lifecycle_start_event(
        self,
        *,
        call: ToolCall,
        context: str,
    ) -> RuntimeStreamEvent:
        metadata: dict[str, object] = {
            "tool_id": self._tool_lifecycle_id(call),
            "call_id": call.call_id or "",
            "name": call.name,
            "context": self._lifecycle_preview(context),
            "display": self._tool_display_projector.project_start(call).to_dict(),
        }
        args_preview = self._tool_args_preview(call)
        if args_preview:
            metadata["args_preview"] = args_preview
        skill_name = self._skill_name(call)
        if skill_name:
            metadata["skill_name"] = skill_name
        metadata.update(_write_content_lifecycle_metadata(call))
        return RuntimeStreamEvent(kind="tool_start", tool_name=call.name, metadata=metadata)

    def _interrupted_tool_result(self, call: ToolCall) -> ToolResult:
        return self._runtime_orchestrator.interrupted_tool_result(call)

    def _tool_lifecycle_progress_event(
        self,
        *,
        call: ToolCall,
    ) -> RuntimeStreamEvent:
        metadata: dict[str, object] = {
            "tool_id": self._tool_lifecycle_id(call),
            "call_id": call.call_id or "",
            "name": call.name,
            "stage": "executing",
            "message": self._lifecycle_preview(f"Executing {call.name}"),
            "display": self._tool_display_projector.project_start(call).to_dict(),
        }
        args_preview = self._tool_args_preview(call)
        if args_preview:
            metadata["args_preview"] = args_preview
        skill_name = self._skill_name(call)
        if skill_name:
            metadata["skill_name"] = skill_name
        return RuntimeStreamEvent(kind="tool_progress", tool_name=call.name, metadata=metadata)

    def _tool_lifecycle_finish_event(
        self,
        *,
        call: ToolCall,
        result: ToolResult,
        duration_seconds: float,
        display: ToolDisplayEnvelope | None = None,
    ) -> RuntimeStreamEvent:
        metadata: dict[str, object] = {
            "tool_id": self._tool_lifecycle_id(call),
            "call_id": call.call_id or "",
            "name": call.name,
            "duration_s": round(duration_seconds, 3),
            "success": result.success,
            "display": (
                display
                or self._tool_display_projector.project_result(
                    call,
                    result,
                    duration_ms=round(duration_seconds * 1000),
                )
            ).to_dict(),
            **self._lifecycle_text_metadata("summary", result.summary),
        }
        if not result.success and result.error:
            metadata.update(self._lifecycle_text_metadata("error", result.error))
            error_kind = result.raw_payload.get("error_kind")
            if isinstance(error_kind, str) and error_kind:
                metadata["error_kind"] = error_kind
        skill_name = self._skill_name(call)
        if skill_name:
            metadata["skill_name"] = skill_name
        metadata.update(_mutation_diff_lifecycle_metadata(call=call, result=result))
        return RuntimeStreamEvent(
            kind="tool_complete" if result.success else "tool_failed",
            tool_name=call.name,
            metadata=metadata,
        )

    def _clarify_request_event(
        self,
        *,
        call: ToolCall,
        result: ToolResult,
    ) -> RuntimeStreamEvent | None:
        if not result.success or call.name != "AskUserQuestion":
            return None
        if result.raw_payload.get("status") != "awaiting_user_response":
            return None
        question = result.raw_payload.get("question")
        if not isinstance(question, str) or not question.strip():
            return None
        request_id = call.call_id or self._tool_lifecycle_id(call)
        metadata: dict[str, object] = {
            "request_id": request_id,
            "tool_id": self._tool_lifecycle_id(call),
            "call_id": call.call_id or "",
            "tool_name": call.name,
            "question": self._lifecycle_preview(question),
            "options": self._clarify_options(result.raw_payload.get("options")),
            "multi_select": bool(result.raw_payload.get("multi_select", False)),
        }
        header = result.raw_payload.get("header")
        if isinstance(header, str) and header.strip():
            metadata["header"] = self._lifecycle_preview(header)
        return RuntimeStreamEvent(kind="clarify_request", tool_name=call.name, metadata=metadata)

    def pending_clarification_from_result(
        self,
        *,
        call: ToolCall,
        result: ToolResult,
    ) -> PendingClarification | None:
        event = self._clarify_request_event(call=call, result=result)
        if event is None:
            return None
        raw_options = event.metadata.get("options")
        return PendingClarification(
            request_id=str(event.metadata["request_id"]),
            tool_call=self._normalize_tool_call(call),
            question=str(event.metadata["question"]),
            options=tuple(
                dict(item)
                for item in raw_options
                if isinstance(item, dict)
            ) if isinstance(raw_options, list) else (),
            header=str(event.metadata.get("header") or ""),
            multi_select=bool(event.metadata.get("multi_select", False)),
        )

    def record_clarification_response(
        self,
        conversation: Conversation,
        *,
        call: ToolCall,
        response: str,
    ) -> None:
        content = f"User answered clarification: {self._lifecycle_preview(response)}"
        self._record_tool_message(
            conversation,
            tool_name=call.name,
            content=content,
            success=True,
            summary="User answered clarification",
            error=None,
            raw_payload={
                "status": "answered",
                "response": response,
            },
            tool_call_id=call.call_id,
        )

    def _clarify_options(self, raw_options: object) -> list[dict[str, object]]:
        if not isinstance(raw_options, list):
            return []
        options: list[dict[str, object]] = []
        for raw_option in raw_options[:MAX_CLARIFY_OPTIONS]:
            if not isinstance(raw_option, dict):
                continue
            label = raw_option.get("label")
            if not isinstance(label, str) or not label.strip():
                continue
            option: dict[str, object] = {"label": self._lifecycle_preview(label)}
            description = raw_option.get("description")
            if isinstance(description, str) and description.strip():
                option["description"] = self._lifecycle_preview(description)
            options.append(option)
        return options

    def _tool_lifecycle_id(self, call: ToolCall) -> str:
        if call.call_id:
            return call.call_id
        digest = hashlib.sha256(repr(call.arguments).encode("utf-8")).hexdigest()[:12]
        return f"{call.name}:{digest}"

    def _append_tool_runtime_lifecycle_trace(
        self,
        *,
        turn_id: str,
        call: ToolCall,
        phase: str,
        status: str,
        policy_decision: str | None = None,
        duration_seconds: float | None = None,
        error_kind: object = None,
        result: ToolResult | None = None,
    ) -> None:
        argument_keys = tuple(
            sorted(str(key) for key in _visible_tool_arguments(call.arguments))
        )
        payload: dict[str, object] = {
            "tool_name": call.name,
            "tool_id": self._tool_lifecycle_id(call),
            "tool_call_id": call.call_id or "",
            "phase": phase,
            "status": status,
            "argument_count": len(argument_keys),
            "argument_keys": list(argument_keys),
        }
        if policy_decision:
            payload["policy_decision"] = policy_decision
        if duration_seconds is not None:
            payload["duration_ms"] = max(0, int(round(duration_seconds * 1000)))
        if isinstance(error_kind, str) and error_kind:
            payload["error_kind"] = error_kind
        if result is not None:
            payload.update(self._shell_process_lifecycle_payload(call=call, result=result))
        self._trace_service.append(
            self._session_id,
            RuntimeTraceEvent(
                kind="tool_runtime_lifecycle",
                turn_id=turn_id,
                payload=payload,
            ),
        )

    def _tool_runtime_terminal_phase(self, result: ToolResult) -> str:
        error_kind = result.raw_payload.get("error_kind")
        if error_kind == "tool_needs_approval":
            return "needs_approval"
        if error_kind == "tool_interrupted":
            return "interrupted"
        if error_kind in _DENIED_ERROR_KINDS:
            return "denied"
        return "completed" if result.success else "failed"

    def _tool_args_preview(self, call: ToolCall) -> str | None:
        preview_parts: list[str] = []
        for key in ("path", "file_path", "query", "command", "url"):
            value = call.arguments.get(key)
            if isinstance(value, str) and value:
                preview_parts.append(f"{key}={self._lifecycle_preview(value)}")
        if not preview_parts:
            return None
        return self._lifecycle_preview(" ".join(preview_parts))

    def _skill_name(self, call: ToolCall) -> str | None:
        if call.name.lower() != "skill":
            return None
        skill_name = call.arguments.get("skill_name")
        if not isinstance(skill_name, str) or not skill_name.strip():
            return None
        return self._lifecycle_preview(skill_name)

    def _lifecycle_preview(self, value: str) -> str:
        normalized = self._context_manager._normalize_whitespace(value)
        if len(normalized) <= MAX_LIFECYCLE_PREVIEW_CHARS:
            return normalized
        return normalized[: MAX_LIFECYCLE_PREVIEW_CHARS - 3] + "..."

    def _record_skill_invocation(
        self,
        *,
        call_id: str | None = None,
        tool_name: str,
        result: ToolResult,
        turn_id: str,
    ) -> None:
        if self._record_invoked_skill is None:
            return
        if tool_name != "Skill" or not result.success:
            return
        skill_name = result.raw_payload.get("skill_name")
        content = result.raw_payload.get("content")
        if not isinstance(skill_name, str) or not skill_name.strip():
            return
        body = content.strip() if isinstance(content, str) else ""
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest() if body else None
        source_path = result.raw_payload.get("source_path")
        skill_name = skill_name.strip()
        self._record_invoked_skill(
            InvokedSkillSnapshot(
                name=skill_name,
                description=str(result.raw_payload.get("description") or ""),
                source_path=source_path if isinstance(source_path, str) else None,
                body_digest=digest,
                cached_body_excerpt=body[:20_000] if body else None,
                invoked_at=datetime.now(UTC),
                last_turn_id=turn_id,
            )
        )
        self._trace_skill_activation(
            turn_id=turn_id,
            skill_name=skill_name,
            call_id=call_id,
            result=result,
            body=body,
            body_digest=digest,
            source_path=source_path if isinstance(source_path, str) else None,
        )

    def _trace_skill_activation(
        self,
        *,
        turn_id: str,
        skill_name: str,
        call_id: str | None,
        result: ToolResult,
        body: str,
        body_digest: str | None,
        source_path: str | None,
    ) -> None:
        payload: dict[str, object] = {
            "skill_name": skill_name,
            "tool_name": "Skill",
            "tool_call_id": call_id or "",
            "description_present": bool(str(result.raw_payload.get("description") or "").strip()),
            "source_path_present": bool(source_path),
            "content_chars": len(body),
            "body_digest": body_digest,
            "replayable": bool(body),
            "cache_class": "dynamic",
            "durability": "persistent",
        }
        source_kind = result.raw_payload.get("source_kind")
        if isinstance(source_kind, str) and source_kind.strip():
            payload["source_kind"] = source_kind.strip()
        self._trace_service.append(
            self._session_id,
            RuntimeTraceEvent(
                kind="skill_activation",
                turn_id=turn_id,
                payload=payload,
            ),
        )

    def _record_skill_instruction_message(
        self,
        conversation: Conversation,
        *,
        tool_name: str,
        result: ToolResult,
        turn_id: str,
        turn_items: list[TurnItem],
    ) -> None:
        if tool_name != "Skill" or not result.success:
            return
        skill_name = result.raw_payload.get("skill_name")
        content = result.raw_payload.get("content")
        if not isinstance(skill_name, str) or not skill_name.strip():
            return
        if not isinstance(content, str) or not content.strip():
            return
        description = result.raw_payload.get("description")
        source_path = result.raw_payload.get("source_path")
        rendered = self._render_skill_instruction_reference(
            skill_name=skill_name.strip(),
            description=description if isinstance(description, str) else "",
            source_path=source_path if isinstance(source_path, str) else "",
            content=content.strip(),
        )
        metadata = {
            "kind": "skill_instructions",
            "skill_name": skill_name.strip(),
            "source_path": source_path if isinstance(source_path, str) else None,
            "cache_class": "dynamic",
            "durability": "persistent",
            "scope": "transcript",
            "model_visible": True,
            "replayable": True,
        }
        conversation.append(
            Message(
                role="user",
                content=rendered,
                metadata=metadata,
            )
        )
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.SKILL_INSTRUCTIONS,
                text=rendered,
                tool_name=tool_name,
                metadata=metadata,
            ),
        )

    def _render_skill_instruction_reference(
        self,
        *,
        skill_name: str,
        description: str,
        source_path: str,
        content: str,
    ) -> str:
        lines = [
            "<skill_instructions>",
            "This is a loaded skill reference for future work in this conversation; "
            "it is not the current user request.",
            f"<name>{skill_name}</name>",
        ]
        if description:
            lines.append(f"<description>{description}</description>")
        if source_path:
            lines.append(f"<path>{source_path}</path>")
        lines.extend(
            [
                "<content>",
                content,
                "</content>",
                "</skill_instructions>",
            ]
        )
        return "\n".join(lines)

    def _tool_execution_trace_payload(
        self,
        *,
        call: ToolCall,
        result: ToolResult,
        duration_seconds: float,
        effect_profile: ToolEffectProfile,
        hook_summaries: tuple[HookExecutionSummary, ...] = (),
    ) -> dict[str, object]:
        duration_ms = max(0, int(round(duration_seconds * 1000)))
        raw_path = result.raw_payload.get("path") or call.arguments.get("file_path") or call.arguments.get("path")
        path = raw_path if isinstance(raw_path, str) and raw_path else None
        error_kind = result.raw_payload.get("error_kind")
        visible_argument_keys = tuple(
            sorted(str(key) for key in _visible_tool_arguments(call.arguments))
        )
        visible_arguments = self._trace_arguments_payload(
            call=call,
            visible_argument_keys=visible_argument_keys,
        )
        raw_payload_keys = self._trace_raw_payload_keys(call=call, result=result)
        output_metadata = self._trace_output_metadata(call=call, result=result)
        return {
            "tool_name": call.name,
            "tool_id": self._tool_lifecycle_id(call),
            "tool_call_id": call.call_id or "",
            "arguments": visible_arguments,
            "argument_preview": self._trace_arguments_preview(visible_arguments),
            "argument_count": len(visible_argument_keys),
            "argument_keys": list(visible_argument_keys),
            "summary": result.summary,
            "result_summary": self._trace_preview(result.summary, max_chars=200),
            "error_summary": (
                None
                if call.name in SHELL_TOOL_NAMES
                else self._trace_preview(result.error, max_chars=200)
            ),
            "success": result.success,
            "status": "succeeded" if result.success else "failed",
            "duration_ms": duration_ms,
            "path": path,
            "error_kind": error_kind if isinstance(error_kind, str) else None,
            "raw_payload_keys": list(raw_payload_keys),
            "filesystem_effect": effect_profile.filesystem,
            "network_effect": effect_profile.network,
            "process_effect": effect_profile.process,
            "hook_summaries": [
                summary.safe_payload() for summary in hook_summaries
            ],
            **output_metadata,
            **self._runtime_enforcement_trace_payload(result.raw_payload),
            **self._write_diagnostics_trace_payload(result.raw_payload),
        }

    def _trace_arguments_payload(
        self,
        *,
        call: ToolCall,
        visible_argument_keys: tuple[str, ...],
    ) -> dict[str, object]:
        if call.name not in SHELL_TOOL_NAMES:
            return _visible_tool_arguments(call.arguments)
        if not visible_argument_keys:
            return {}
        return {
            "redacted": True,
            "argument_count": len(visible_argument_keys),
        }

    def _trace_output_metadata(
        self,
        *,
        call: ToolCall,
        result: ToolResult,
    ) -> dict[str, object]:
        if call.name not in SHELL_TOOL_NAMES:
            return {
                **self._trace_text_metadata("stdout", result.raw_payload.get("stdout")),
                **self._trace_text_metadata("stderr", result.raw_payload.get("stderr")),
            }
        return {
            "stdout_preview": None,
            "stdout_chars": self._trace_text_chars(result.raw_payload.get("stdout")),
            "stdout_truncated": bool(result.raw_payload.get("stdout_truncated", False)),
            "stderr_preview": None,
            "stderr_chars": self._trace_text_chars(result.raw_payload.get("stderr")),
            "stderr_truncated": bool(result.raw_payload.get("stderr_truncated", False)),
        }

    def _trace_raw_payload_keys(
        self,
        *,
        call: ToolCall,
        result: ToolResult,
    ) -> tuple[str, ...]:
        if call.name not in SHELL_TOOL_NAMES:
            return tuple(sorted(str(key) for key in result.raw_payload))
        allowed_shell_keys = {
            "cleanup_result",
            "command_hash",
            "command_length",
            "command_pattern",
            "cwd",
            "duration_ms",
            "error_kind",
            "exit_code",
            "last_observed_at",
            "new_output_chars",
            "output_chars",
            "process_state",
            "runtime_enforcement",
            "shell_id",
            "shell_kind",
            "shell_edition",
            "stderr_chars",
            "stderr_truncated",
            "stdout_chars",
            "stdout_truncated",
            "terminal_state",
            "timed_out",
            "truncated",
            "truncated_chars",
        }
        return tuple(
            sorted(
                str(key)
                for key in result.raw_payload
                if str(key) in allowed_shell_keys
            )
        )

    def _runtime_enforcement_trace_payload(
        self,
        result_payload: dict[str, object],
    ) -> dict[str, object]:
        runtime_enforcement = result_payload.get("runtime_enforcement")
        if not isinstance(runtime_enforcement, dict):
            return {"runtime_enforcement": None}
        allowed_keys = {
            "backend",
            "custom_shell_path",
            "filesystem",
            "network",
            "shell",
            "shell_environment_policy",
            "shell_kind",
            "shell_edition",
            "env_policy",
            "env_keys",
            "timeout_seconds",
            "timeout_capped",
            "output_char_limit",
            "cwd",
        }
        return {
            "runtime_enforcement": {
                key: runtime_enforcement[key]
                for key in sorted(allowed_keys)
                if key in runtime_enforcement
            }
        }

    def _write_diagnostics_trace_payload(
        self,
        result_payload: dict[str, object],
    ) -> dict[str, object]:
        diagnostics = result_payload.get("write_diagnostics")
        if not isinstance(diagnostics, dict):
            return {
                "write_diagnostics_count": None,
                "write_diagnostics_error": None,
            }
        count = diagnostics.get("count")
        error = diagnostics.get("error")
        return {
            "write_diagnostics_count": count if isinstance(count, int) else None,
            "write_diagnostics_error": error if isinstance(error, str) else None,
        }

    def _shell_process_lifecycle_payload(
        self,
        *,
        call: ToolCall,
        result: ToolResult,
    ) -> dict[str, object]:
        if call.name not in {
            "Shell",
            "Bash",
            "run_shell",
            "ShellOutput",
            "BashOutput",
            "WriteStdin",
            "KillShell",
        }:
            return {}
        result_payload = result.raw_payload
        payload: dict[str, object] = {}
        shell_id = result_payload.get("shell_id") or result_payload.get("bash_id")
        if isinstance(shell_id, str) and shell_id:
            payload["shell_id"] = shell_id
        for key in (
            "process_state",
            "terminal_state",
            "cleanup_result",
            "command_hash",
            "command_pattern",
        ):
            value = result_payload.get(key)
            if isinstance(value, str) and value:
                payload[key] = value
        for key in (
            "command_length",
            "output_chars",
            "new_output_chars",
            "stdout_chars",
            "stderr_chars",
            "truncated_chars",
        ):
            value = result_payload.get(key)
            if isinstance(value, int):
                payload[key] = value
        for key in ("stdout_truncated", "stderr_truncated", "truncated"):
            value = result_payload.get(key)
            if isinstance(value, bool):
                payload[key] = value
        return payload

    def _effect_profile_for_call(
        self,
        *,
        call: ToolCall,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
    ) -> ToolEffectProfile:
        try:
            return tool_router.effect_profile(call, exposure=tool_exposure)
        except ValueError:
            return ToolEffectProfile()

    def _record_tool_message(
        self,
        conversation: Conversation,
        *,
        tool_name: str,
        content: str,
        success: bool,
        summary: str,
        error: str | None,
        raw_payload: dict[str, object],
        evidence: tuple[ToolEvidence, ...] = (),
        tool_call_id: str | None = None,
        post_tool_contexts: tuple[str, ...] = (),
        function_call_output_payload: ResponsesFunctionCallOutputPayload | None = None,
    ) -> None:
        post_tool_context_metadata = (
            {"post_tool_additional_contexts": post_tool_contexts}
            if post_tool_contexts
            else {}
        )
        blocks: tuple[RuntimeBlock, ...] = ()
        if tool_call_id:
            blocks = (
                RuntimeBlock(
                    type="tool_result",
                    text=content,
                    call_id=tool_call_id,
                    metadata={
                        "tool_name": tool_name,
                        "success": success,
                        "summary": summary,
                        "error": error,
                        "path": raw_payload.get("path"),
                        "stdout": raw_payload.get("stdout"),
                        "stderr": raw_payload.get("stderr"),
                        "content": raw_payload.get("content"),
                        "matches": raw_payload.get("matches"),
                        "evidence": [self._serialize_evidence(item) for item in evidence],
                        "error_kind": raw_payload.get("error_kind"),
                        "function_call_output_payload": (
                            function_call_output_payload
                            or ResponsesFunctionCallOutputPayload.from_text(
                                content, success=success
                            )
                        ).to_dict(),
                        **post_tool_context_metadata,
                    },
                ),
            )
        conversation.append(
            Message(
                role="tool",
                content=content,
                tool_call_id=tool_call_id,
                blocks=blocks,
                metadata={
                    "tool_name": tool_name,
                    "append_only": True,
                    "l1_truncated": True,
                    **post_tool_context_metadata,
                },
            )
        )

    def _function_call_output_payload(
        self,
        output: ToolModelOutput,
        *,
        guarded_text: str,
    ) -> ResponsesFunctionCallOutputPayload:
        structured_content = tuple(
            item.value for item in output.content if isinstance(item, ToolJsonContent)
        )
        images = tuple(
            item for item in output.content if isinstance(item, ToolImageContent)
        )
        if not images:
            return ResponsesFunctionCallOutputPayload.from_text(
                guarded_text,
                success=output.success,
                structured_content=structured_content,
            )
        return ResponsesFunctionCallOutputPayload.from_content_items(
            (
                ResponsesFunctionCallOutputTextItem(text=guarded_text),
                *(
                    ResponsesFunctionCallOutputImageItem(
                        image_url=item.image_url,
                        detail=item.detail,
                    )
                    for item in images
                ),
            ),
            fallback_text=guarded_text,
            success=output.success,
            structured_content=structured_content,
        )

    def _record_assistant_tool_call(
        self,
        conversation: Conversation,
        *,
        tool_call: ToolCall,
        provider_id: str | None = None,
        response_id: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> None:
        normalized_call = self._normalize_tool_call(tool_call)
        block_metadata = {} if metadata is None else dict(metadata)
        conversation.append(
            Message(
                role="assistant",
                content="",
                tool_calls=(normalized_call,),
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name=normalized_call.name,
                        tool_arguments=normalized_call.arguments,
                        call_id=normalized_call.call_id or "",
                        provider_id=provider_id,
                        metadata=block_metadata,
                    ),
                ),
                response_id=response_id,
            )
        )

    def _tool_activity_event(
        self,
        call: ToolCall,
        *,
        phase: str,
        result_summary: str | None = None,
    ) -> ActivityEvent:
        prefix = self._tool_activity_prefix(call)
        if phase == "start":
            return ActivityEvent(
                kind="tool_started",
                message=prefix,
                tool_name=call.name,
                path=self._activity_path(call),
                query=self._activity_query(call),
                preview=self._activity_preview(call),
            )
        done_message = self._tool_finished_message(call, result_summary=result_summary)
        return ActivityEvent(
            kind="tool_finished",
            message=done_message,
            tool_name=call.name,
            path=self._activity_path(call),
            query=self._activity_query(call),
            preview=self._activity_preview(call),
        )

    def _tool_activity_prefix(self, call: ToolCall) -> str:
        path = self._activity_path(call)
        query = self._activity_query(call)
        if call.name == "LS":
            return path or "."
        if call.name == "Read":
            return path or "<unknown>"
        if call.name == "Grep":
            message = f"query={query or '<unknown>'}"
            include = call.arguments.get("include")
            if isinstance(include, str) and include:
                message += f" include={include}"
            return message
        if call.name in FILE_MUTATION_TOOLS:
            return path or "<unknown>"
        if call.name == "Plan":
            return "updating task plan"
        if call.name in {"Shell", "Bash"}:
            return self._activity_preview(call) or call.name
        return call.name

    def _tool_finished_message(self, call: ToolCall, *, result_summary: str | None) -> str:
        path = self._activity_path(call)
        query = self._activity_query(call)
        if call.name == "Grep":
            return f"query={query or '<unknown>'}"
        if call.name == "Read":
            return path or "<unknown>"
        if call.name in FILE_MUTATION_TOOLS:
            return path or "<unknown>"
        if call.name in {"Shell", "Bash"}:
            return self._activity_preview(call) or (result_summary or call.name)
        if call.name == "Plan":
            return "updated task plan"
        return call.name

    def _activity_path(self, call: ToolCall) -> str | None:
        value = call.arguments.get("file_path") or call.arguments.get("path")
        return value if isinstance(value, str) and value else None

    def _activity_query(self, call: ToolCall) -> str | None:
        value = call.arguments.get("query")
        return value if isinstance(value, str) and value else None

    def _activity_preview(self, call: ToolCall) -> str | None:
        command = call.arguments.get("command")
        if isinstance(command, str) and command:
            return command
        args = call.arguments.get("args")
        if isinstance(args, list):
            parts = [item for item in args if isinstance(item, str)]
            if parts:
                return " ".join(parts)
        return None

    def _trace_preview(self, value: object, *, max_chars: int = 120) -> str | None:
        if not isinstance(value, str) or not value.strip():
            return None
        normalized = self._context_manager._normalize_whitespace(value)
        if len(normalized) <= max_chars:
            return normalized
        return normalized[: max_chars - 3] + "..."

    def _trace_arguments_preview(self, arguments: dict[str, object]) -> str:
        if not arguments:
            return ""
        parts: list[str] = []
        for key in sorted(str(item) for item in arguments):
            value = arguments.get(key)
            parts.append(f"{key}={self._trace_argument_value(key, value)}")
        return self._lifecycle_preview(" ".join(parts))

    def _trace_argument_value(self, key: str, value: object) -> str:
        lowered = key.lower()
        if any(hint in lowered for hint in ("secret", "token", "password", "key", "auth")):
            return "<redacted>"
        if isinstance(value, str):
            return self._lifecycle_preview(value)
        if isinstance(value, bool | int | float):
            return str(value)
        if value is None:
            return "null"
        if isinstance(value, list):
            return f"<list:{len(value)}>"
        if isinstance(value, dict):
            return f"<object:{len(value)}>"
        return f"<{type(value).__name__}>"

    def _trace_text_metadata(
        self,
        prefix: str,
        value: object,
        *,
        max_chars: int = 120,
    ) -> dict[str, object]:
        if not isinstance(value, str) or not value.strip():
            return {
                f"{prefix}_preview": None,
                f"{prefix}_chars": 0,
                f"{prefix}_truncated": False,
            }
        normalized = self._context_manager._normalize_whitespace(value)
        return {
            f"{prefix}_preview": self._trace_preview(value, max_chars=max_chars),
            f"{prefix}_chars": len(normalized),
            f"{prefix}_truncated": len(normalized) > max_chars,
        }

    def _trace_text_chars(self, value: object) -> int:
        if not isinstance(value, str) or not value.strip():
            return 0
        return len(self._context_manager._normalize_whitespace(value))

    def _lifecycle_text_metadata(self, prefix: str, value: str) -> dict[str, object]:
        normalized = self._context_manager._normalize_whitespace(value)
        return {
            prefix: self._lifecycle_preview(value),
            f"{prefix}_chars": len(normalized),
            f"{prefix}_truncated": len(normalized) > MAX_LIFECYCLE_PREVIEW_CHARS,
        }

    def _serialize_evidence(self, evidence: ToolEvidence) -> dict[str, object]:
        return {
            "kind": evidence.kind,
            "title": evidence.title,
            "path": evidence.path,
            "line_start": evidence.line_start,
            "line_end": evidence.line_end,
            "snippet": evidence.snippet,
            "metadata": dict(evidence.metadata),
        }


def _raise_if_interrupted(interrupt_token: RuntimeInterruptToken | None) -> None:
    if interrupt_token is not None:
        interrupt_token.raise_if_interrupted()


def _render_plan_steps(plan_state: PlanState) -> list[str]:
    return [f"{item.status.value}: {item.content}" for item in plan_state.items]


def _plan_payload(plan_state: PlanState) -> dict[str, object]:
    return {
        "items": [
            _plan_item_payload(item)
            for item in plan_state.items
        ],
    }


def _plan_update_metadata(
    plan_state: PlanState,
    *,
    source: str,
) -> dict[str, object]:
    return {
        "source": source,
        "completed": sum(
            item.status is PlanStatus.COMPLETED for item in plan_state.items
        ),
        "total": len(plan_state.items),
        "items": [_plan_item_payload(item) for item in plan_state.items],
        "model_visible": False,
    }


def _live_plan_update_payload(
    plan_state: PlanState,
    *,
    metadata: dict[str, object],
) -> dict[str, object]:
    raw_items = metadata["items"]
    return {
        "plan_steps": _render_plan_steps(plan_state),
        "plan": {"items": raw_items},
        "source": metadata["source"],
        "completed": metadata["completed"],
        "total": metadata["total"],
    }


def _plan_item_payload(item: PlanItem) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": item.id,
        "text": item.content,
        "status": item.status.value,
    }
    if item.evidence:
        payload["evidence"] = list(item.evidence)
    return payload


def _visible_tool_arguments(arguments: dict[str, object]) -> dict[str, object]:
    return {
        key: value
        for key, value in arguments.items()
        if not str(key).startswith("_")
    }


def _tool_call_path(call: ToolCall) -> str | None:
    value = call.arguments.get("file_path") or call.arguments.get("path")
    return value if isinstance(value, str) and value else None


def _write_content_lifecycle_metadata(call: ToolCall) -> dict[str, object]:
    if call.name not in {"Write", "write_file"}:
        return {}
    content = call.arguments.get("content")
    if not isinstance(content, str):
        return {}
    preview, truncated = _bounded_lifecycle_text(
        content,
        max_chars=MAX_LIFECYCLE_CONTENT_PREVIEW_CHARS,
    )
    return {
        "content_preview": preview,
        "content_line_count": _line_count(content),
        "content_chars": len(content),
        "content_truncated": truncated,
    }


def _mutation_diff_lifecycle_metadata(*, call: ToolCall, result: ToolResult) -> dict[str, object]:
    if call.name not in FILE_MUTATION_TOOLS:
        return {}
    diff = result.raw_payload.get("diff")
    if not isinstance(diff, str) or not diff:
        return {}
    preview, truncated = _bounded_lifecycle_text(
        diff,
        max_chars=MAX_LIFECYCLE_DIFF_PREVIEW_CHARS,
    )
    return {
        "diff": preview,
        "diff_chars": len(diff),
        "diff_truncated": truncated,
    }


def _bounded_lifecycle_text(value: str, *, max_chars: int) -> tuple[str, bool]:
    if len(value) <= max_chars:
        return value, False
    return value[:max_chars], True


def _line_count(value: str) -> int:
    stripped = value.rstrip("\n")
    if not stripped:
        return 0
    return stripped.count("\n") + 1

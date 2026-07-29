from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import uuid4

from mycli.application.runtime.recovery import (
    ErrorClassifier,
    RecoveryErrorClass,
    RecoveryPolicy,
    RecoveryPolicyAction,
    RetryBackoffPolicy,
    fallback_metadata,
    is_transient_recovery_failure,
    recovery_diagnostic_metadata,
    retry_metadata,
)
from mycli.application.runtime.model.model_turn_requester import ModelTurnInterrupted
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    ActivityEvent,
    CompactionRehydrationContext,
    ContextBaseline,
    DecisionAction,
    PendingClarification,
    PendingDecision,
    PlanState,
    RequestShape,
    RuntimeBlock,
    RuntimeStreamEvent,
    RuntimeTraceEvent,
    RuntimeInterruptToken,
    RuntimeItem,
    ModelTurnResult,
    SessionCommandAllowance,
    ShellKind,
    StopReason,
    SuspendedTurn,
    TurnItem,
    TurnItemType,
    TurnResponse,
    TurnStatus,
    UserMessageInput,
)
from mycli.domain.runtime.images import local_image_block
from mycli.memory.dream_service import MemoryDreamRequest
from mycli.memory.extraction_service import MemoryExtractionRequest
from mycli.application.runtime.turn_error_finalizer import TurnErrorFinalizer
from mycli.domain.logging import LogLevel
from mycli.services.context.compaction import CompactPhase, CompactReason, ContextBudget
from mycli.services.hooks import HookAction, HookContext, HookPoint, HookResult
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.services.execpolicy import ExecPolicyRefreshError
from mycli.services.execpolicy_writer import (
    ExecPolicyWriteError,
    ExecPolicyWriteResult,
)
from mycli.services.turn_guard import ContinueReason, NoProgressTracker

if TYPE_CHECKING:
    from mycli.application.runtime.agent_runtime import AgentRuntime
    from mycli.llms.adapters.base import ModelToolDefinition


INTERRUPTED_TURN_MARKER = (
    "<turn_aborted>\n"
    "The user interrupted the previous turn on purpose. Any running tools or "
    "commands may have partially executed.\n"
    "</turn_aborted>"
)


class TurnExecutor:
    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime
        self._error_finalizer = TurnErrorFinalizer(runtime)

    def execute_user_turn(
        self,
        user_message: str,
        image_paths: tuple[str, ...] = (),
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
        turn_id: str | None = None,
        client_user_message_id: str | None = None,
    ) -> TurnResponse:
        runtime = self._runtime
        _raise_if_interrupted(interrupt_token)
        runtime._restore_model()
        decision = runtime._session_service.load_pending_decision(runtime._config.session_id)
        if decision is not None:
            return TurnResponse(
                assistant_message=(
                    "There is a pending risky action waiting for your decision. "
                    f"Please choose {runtime._approval_decisions.format_allowed_choices(decision.options)}."
                ),
                pending_decision=decision,
            )
        suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
        if suspended is not None and suspended.pending_approval is not None:
            pending_decision = runtime._approval_decisions.pending_decision_from_approval(
                suspended.pending_approval
            )
            return TurnResponse(
                assistant_message=(
                    "There is a pending risky action waiting for your decision. "
                    f"Please choose {runtime._approval_decisions.format_allowed_choices(pending_decision.options)}."
                ),
                pending_decision=pending_decision,
            )
        if suspended is not None:
            if _is_legacy_interrupted_snapshot(suspended):
                runtime._session_service.clear_suspended_turn(runtime._config.session_id)
            else:
                return self._resume_interrupted_turn(suspended)

        conversation = runtime._session_service.load_conversation(runtime._config.session_id)
        current_plan_state = runtime._session_service.load_plan_state(runtime._config.session_id)
        if _repair_interrupted_tool_results(conversation):
            runtime._save_runtime_state(
                conversation=conversation,
                plan_state=current_plan_state,
            )
        initial_in_progress_item_id = current_plan_state.current_in_progress_item_id()
        resolved_turn_id = turn_id or f"turn_{uuid4().hex}"
        runtime._set_current_turn_id(resolved_turn_id)
        started_at = runtime._event_ledger.timestamp()
        turn_items: list[TurnItem] = []
        runtime._load_model_continuation_state(turn_id=resolved_turn_id)
        prompt_hook_execution = runtime._hook_manager.execute_with_summary(
            HookPoint.USER_PROMPT_SUBMIT,
            HookContext(
                hook_point=HookPoint.USER_PROMPT_SUBMIT,
                session_id=runtime._config.session_id,
                metadata={
                    "turn_id": resolved_turn_id,
                    "prompt_chars": len(user_message),
                    "prompt": user_message,
                },
            ),
        )
        for hook_result in prompt_hook_execution.results:
            if hook_result.action is HookAction.DENY:
                assistant_message = hook_result.message or "User prompt blocked by hook."
                runtime._append_turn_item(
                    turn_id=resolved_turn_id,
                    turn_items=turn_items,
                    item=TurnItem(
                        type=TurnItemType.WARNING,
                        text=assistant_message,
                        metadata={"hook_point": HookPoint.USER_PROMPT_SUBMIT.value},
                    ),
                )
                return runtime._finalize_response(
                    response=TurnResponse(
                        assistant_message=assistant_message,
                        activity_events=(
                            ActivityEvent(
                                kind="hook_blocked",
                                message="user prompt blocked by hook",
                            ),
                        ),
                    ),
                    turn_id=resolved_turn_id,
                    user_message=user_message,
                    started_at=started_at,
                    status=TurnStatus.REJECTED,
                    stop_reason=StopReason.RUNTIME_ERROR,
                    turn_items=turn_items,
                )
        runtime.begin_active_turn_mailbox(
            resolved_turn_id,
            steerable=True,
            turn_kind="regular",
        )
        try:
            runtime._user_message_lifecycle.commit(
                turn_id=resolved_turn_id,
                item=UserMessageInput(
                    client_user_message_id=client_user_message_id or resolved_turn_id,
                    text=user_message,
                    image_paths=image_paths,
                    source="submit",
                ),
                conversation=conversation,
                turn_items=turn_items,
                stream_sink=stream_sink,
            )
        except Exception:
            runtime.close_active_turn_mailbox(resolved_turn_id)
            raise
        if image_paths and not runtime._config.supports_images:
            self._commit_leftovers_before_finalize(
                conversation=conversation,
                turn_id=resolved_turn_id,
                turn_items=turn_items,
                stream_sink=stream_sink,
            )
        unsupported_image_response = self._unsupported_image_response(
            user_message=user_message,
            image_paths=image_paths,
            turn_id=resolved_turn_id,
            started_at=started_at,
            turn_items=turn_items,
        )
        if unsupported_image_response is not None:
            return unsupported_image_response
        initial_hook_contexts = runtime._session_hook_additional_contexts(
            source="startup"
        ) + _hook_additional_contexts(prompt_hook_execution.results)
        return self._run_turn_loop(
            user_message=user_message,
            conversation=conversation,
            current_plan_state=current_plan_state,
            initial_in_progress_item_id=initial_in_progress_item_id,
            turn_id=resolved_turn_id,
            started_at=started_at,
            turn_items=turn_items,
            progress_updates=[],
            activity_events=[],
            streamed_chunks=[],
            stream_sink=stream_sink,
            initial_runtime_reminders=initial_hook_contexts,
            interrupt_token=interrupt_token,
        )

    def _user_message_blocks(
        self,
        *,
        user_message: str,
        image_paths: tuple[str, ...],
    ) -> tuple[RuntimeBlock, ...]:
        blocks: list[RuntimeBlock] = []
        if user_message:
            blocks.append(RuntimeBlock(type="text", text=user_message))
        blocks.extend(local_image_block(path) for path in image_paths if path)
        return tuple(blocks)

    def _unsupported_image_response(
        self,
        *,
        user_message: str,
        image_paths: tuple[str, ...],
        turn_id: str,
        started_at: str,
        turn_items: list[TurnItem],
    ) -> TurnResponse | None:
        if not image_paths or self._runtime._config.supports_images:
            return None
        runtime = self._runtime
        assistant_message = (
            "This model configuration does not support image input. "
            "Switch to a vision-capable model or set [model].supports_images = true "
            "if your compatible endpoint supports multimodal input."
        )
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.WARNING,
                text=assistant_message,
                metadata={
                    "reason": "model_does_not_support_images",
                    "provider": runtime._config.provider.value,
                    "protocol": runtime._config.protocol.value,
                    "model": runtime._config.model,
                },
            ),
        )
        return runtime._finalize_response(
            response=TurnResponse(
                assistant_message=assistant_message,
                activity_events=(
                    ActivityEvent(
                        kind="model_capability",
                        message="image input blocked by model configuration",
                    ),
                ),
            ),
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=TurnStatus.FAILED,
            stop_reason=StopReason.MODEL_ERROR,
            turn_items=turn_items,
        )

    def _resume_interrupted_turn(self, suspended: SuspendedTurn) -> TurnResponse:
        runtime = self._runtime
        runtime._session_service.clear_suspended_turn(runtime._config.session_id)
        current_plan_state = suspended.plan_state
        turn_id = f"turn_{uuid4().hex}"
        runtime._set_current_turn_id(turn_id)
        started_at = runtime._event_ledger.timestamp()
        turn_items: list[TurnItem] = []
        runtime._load_model_continuation_state(turn_id=turn_id)
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.WARNING,
                text="Resuming interrupted turn from saved context.",
            ),
        )
        return self._run_turn_loop(
            user_message=suspended.user_message,
            conversation=Conversation(
                session_id=runtime._config.session_id,
                messages=list(suspended.conversation),
            ),
            current_plan_state=current_plan_state,
            initial_in_progress_item_id=current_plan_state.current_in_progress_item_id(),
            turn_id=turn_id,
            started_at=started_at,
            turn_items=turn_items,
            progress_updates=["[resume] interrupted turn"],
            activity_events=[
                ActivityEvent(
                    kind="thinking",
                    message="resuming interrupted turn",
                )
            ],
            streamed_chunks=[],
        )

    def resolve_pending_approval(
        self,
        choice: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> TurnResponse:
        runtime = self._runtime
        _raise_if_interrupted(interrupt_token)
        normalized = choice.strip()
        decision = runtime._session_service.load_pending_decision(runtime._config.session_id)
        suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
        if decision is None and suspended is not None and suspended.pending_approval is not None:
            decision = runtime._approval_decisions.pending_decision_from_approval(
                suspended.pending_approval
            )
            runtime._session_service.save_pending_decision(runtime._config.session_id, decision)
            _record_approval_recovery(
                runtime=runtime,
                turn_id=f"approval_{uuid4().hex}",
                result="recovered_from_suspended_turn",
                pending_decision=True,
                suspended_turn=True,
                pending_approval=True,
                decision=decision,
            )
        if decision is None:
            _record_approval_resolution(
                runtime=runtime,
                turn_id=f"approval_{uuid4().hex}",
                result="no_pending_decision",
                choice=normalized,
                decision=None,
            )
            return TurnResponse(assistant_message="There is no pending decision to resolve.")

        choice_to_action = {
            "1": DecisionAction.APPROVE_ONCE,
            "2": DecisionAction.REJECT,
            "3": DecisionAction.ALLOW_SESSION,
            "4": DecisionAction.ALWAYS_ALLOW,
        }
        allowed_choices = tuple(
            key for key, action in choice_to_action.items() if action in decision.options
        )
        if normalized not in allowed_choices:
            _record_approval_resolution(
                runtime=runtime,
                turn_id=f"approval_{uuid4().hex}",
                result="invalid_choice",
                choice=normalized,
                decision=decision,
            )
            return TurnResponse(
                assistant_message=(
                    f"Please choose {runtime._approval_decisions.format_allowed_choices(decision.options)}."
                ),
                pending_decision=decision,
            )

        selected_action = choice_to_action[normalized]
        if selected_action is DecisionAction.ALLOW_SESSION and not decision.command_pattern:
            _record_approval_resolution(
                runtime=runtime,
                turn_id=f"approval_{uuid4().hex}",
                result="allow_session_unavailable",
                choice=normalized,
                decision=decision,
            )
            return TurnResponse(
                assistant_message=(
                    f"Please choose {runtime._approval_decisions.format_allowed_choices(decision.options)}."
                ),
                pending_decision=decision,
            )
        if (
            selected_action is DecisionAction.ALWAYS_ALLOW
            and decision.proposed_execpolicy_pattern is None
        ):
            _record_approval_resolution(
                runtime=runtime,
                turn_id=f"approval_{uuid4().hex}",
                result="always_allow_unavailable",
                choice=normalized,
                decision=decision,
            )
            return TurnResponse(
                assistant_message=(
                    f"Please choose {runtime._approval_decisions.format_allowed_choices(decision.options)}."
                ),
                pending_decision=decision,
            )

        if suspended is None:
            suspended = runtime._session_service.reconstruct_suspended_turn(
                runtime._config.session_id,
                decision,
            )

        current_plan_state = runtime._session_service.load_plan_state(runtime._config.session_id)
        turn_id = f"turn_{uuid4().hex}"
        runtime._set_current_turn_id(turn_id)
        started_at = runtime._event_ledger.timestamp()
        turn_items: list[TurnItem] = []
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.APPROVAL_RESOLUTION,
                text=f"[decision] {normalized}",
                tool_name=decision.tool_call.name,
                call_id=decision.tool_call.call_id,
            ),
        )
        if selected_action is DecisionAction.REJECT:
            _record_approval_resolution(
                runtime=runtime,
                turn_id=turn_id,
                result="rejected",
                choice=normalized,
                decision=decision,
            )
            runtime._session_service.clear_pending_decision(runtime._config.session_id)
            runtime._session_service.clear_suspended_turn(runtime._config.session_id)
            message = f"Rejected {decision.tool_call.name}. Pending decision cleared."
            if runtime._config.memory_enabled:
                runtime._memory_service.append_session_summary(
                    runtime._config.session_id,
                    message,
                )
            user_message = suspended.user_message if suspended is not None else ""
            return runtime._finalize_response(
                response=TurnResponse(
                    assistant_message=message,
                    progress_updates=("[decision] rejected",),
                ),
                turn_id=turn_id,
                user_message=user_message,
                started_at=started_at,
                status=TurnStatus.REJECTED,
                stop_reason=StopReason.APPROVAL_REJECTED,
                turn_items=turn_items,
            )

        if suspended is None or suspended.pending_approval is None:
            _record_approval_recovery(
                runtime=runtime,
                turn_id=turn_id,
                result="missing_suspended_turn",
                pending_decision=True,
                suspended_turn=suspended is not None,
                pending_approval=False,
                decision=decision,
            )
            _record_approval_resolution(
                runtime=runtime,
                turn_id=turn_id,
                result="missing_suspended_turn",
                choice=normalized,
                decision=decision,
            )
            return TurnResponse(
                assistant_message=(
                    "The pending decision exists, but the suspended turn cannot be resumed."
                ),
                pending_decision=decision,
            )

        if selected_action is DecisionAction.ALWAYS_ALLOW:
            pattern = decision.proposed_execpolicy_pattern
            assert pattern is not None
            try:
                write_result = runtime._execpolicy_writer.allow_prefix(pattern)
            except ExecPolicyWriteError as exc:
                _record_persistent_approval_failure(
                    runtime=runtime,
                    turn_id=turn_id,
                    decision=decision,
                    stage="write",
                    error=exc,
                )
                return TurnResponse(
                    assistant_message=(
                        "Could not persist the Shell approval. The command is still pending."
                    ),
                    pending_decision=decision,
                )
            try:
                runtime.refresh_execpolicy_rules()
            except ExecPolicyRefreshError as exc:
                _record_persistent_approval_failure(
                    runtime=runtime,
                    turn_id=turn_id,
                    decision=decision,
                    stage="refresh",
                    error=exc,
                )
                return TurnResponse(
                    assistant_message=(
                        "The Shell rule was persisted but could not be activated "
                        "in this runtime. The command is still pending."
                    ),
                    pending_decision=decision,
                )
            _record_persistent_approval(
                runtime=runtime,
                turn_id=turn_id,
                decision=decision,
                write_result=write_result,
            )

        if selected_action is DecisionAction.ALLOW_SESSION and decision.command_pattern:
            previous_allowances = runtime._session_service.load_command_allowances(
                runtime._config.session_id
            )
            shell_kind = _decision_shell_kind(decision)
            allowance = SessionCommandAllowance(
                command_pattern=decision.command_pattern,
                shell_kind=shell_kind,
            )
            new_allowance = allowance not in previous_allowances
            runtime._session_service.add_command_allowance(
                runtime._config.session_id,
                allowance,
            )
            _record_approval_allowance(
                runtime=runtime,
                turn_id=turn_id,
                decision=decision,
                new_allowance=new_allowance,
            )

        runtime._session_service.clear_pending_decision(runtime._config.session_id)
        runtime._session_service.clear_suspended_turn(runtime._config.session_id)

        approved_call = runtime._assistant_conversation_recorder.normalize_tool_call(
            suspended.pending_approval.tool_call
        )
        conversation = Conversation(
            session_id=runtime._config.session_id,
            messages=list(suspended.conversation),
        )
        initial_in_progress_item_id = current_plan_state.current_in_progress_item_id()
        runtime._load_model_continuation_state(turn_id=turn_id)
        progress_updates = ["[decision] approved"]
        activity_events: list[ActivityEvent] = []
        streamed_chunks: list[str] = []
        try:
            initial_planned_exposure = runtime._plan_tool_exposure(
                user_message=suspended.user_message,
                conversation=conversation,
                plan_state=current_plan_state,
                interrupt_token=interrupt_token,
            )
        except KeyboardInterrupt:
            return self._finalize_interrupted_turn(
                user_message=suspended.user_message,
                conversation=conversation,
                current_plan_state=current_plan_state,
                turn_id=turn_id,
                started_at=started_at,
                turn_items=turn_items,
                latest_context_baseline=None,
                activity_events=activity_events,
                streamed_chunks=streamed_chunks,
                progress_updates=progress_updates,
                stream_sink=stream_sink,
                interrupt_token=interrupt_token,
            )
        if initial_planned_exposure.lifecycle_events:
            runtime._append_contributed_tool_lifecycle_events(
                turn_id=turn_id,
                turn_items=turn_items,
                activity_events=activity_events,
                lifecycle_events=initial_planned_exposure.lifecycle_events,
            )
        last_tool_exposure_summary: dict[str, list[str]] | None = None
        if initial_planned_exposure.exposure.summary() != last_tool_exposure_summary:
            runtime._tool_orchestrator.append_tool_exposure_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                activity_events=activity_events,
                tool_exposure=initial_planned_exposure.exposure,
            )
            last_tool_exposure_summary = initial_planned_exposure.exposure.summary()
        initial_tool_router = runtime._tool_orchestrator.build_tool_router(initial_planned_exposure)
        try:
            current_plan_state = runtime._tool_execution_service.execute_tool_call(
                conversation=conversation,
                call=approved_call,
                tool_router=initial_tool_router,
                tool_exposure=initial_planned_exposure.exposure,
                plan_state=current_plan_state,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                record_assistant_call=False,
                lifecycle_sink=stream_sink,
                policy_approved=True,
                interrupt_token=interrupt_token,
            )
        except KeyboardInterrupt:
            return self._finalize_interrupted_turn(
                user_message=suspended.user_message,
                conversation=conversation,
                current_plan_state=current_plan_state,
                turn_id=turn_id,
                started_at=started_at,
                turn_items=turn_items,
                latest_context_baseline=None,
                activity_events=activity_events,
                streamed_chunks=streamed_chunks,
                progress_updates=progress_updates,
                stream_sink=stream_sink,
                interrupt_token=interrupt_token,
            )

        pending_batch_items = _unresolved_tool_call_items_for_current_turn(conversation)
        if pending_batch_items:
            try:
                (
                    current_plan_state,
                    _turn_has_tool_call,
                    _turn_text_chunks,
                    early_response,
                ) = runtime._assistant_block_consumer.consume_assistant_blocks(
                    turn_result=ModelTurnResult(
                        items=pending_batch_items,
                        done=False,
                    ),
                    conversation=conversation,
                    tool_router=initial_tool_router,
                    tool_exposure=initial_planned_exposure.exposure,
                    plan_state=current_plan_state,
                    turn_id=turn_id,
                    user_message=suspended.user_message,
                    progress_updates=progress_updates,
                    activity_events=activity_events,
                    streamed_chunks=streamed_chunks,
                    turn_items=turn_items,
                    stream_sink=stream_sink,
                    conversation_items_precommitted=True,
                    interrupt_token=interrupt_token,
                )
            except KeyboardInterrupt:
                return self._finalize_interrupted_turn(
                    user_message=suspended.user_message,
                    conversation=conversation,
                    current_plan_state=current_plan_state,
                    turn_id=turn_id,
                    started_at=started_at,
                    turn_items=turn_items,
                    latest_context_baseline=None,
                    activity_events=activity_events,
                    streamed_chunks=streamed_chunks,
                    progress_updates=progress_updates,
                    stream_sink=stream_sink,
                    interrupt_token=interrupt_token,
                )
            if early_response is not None:
                response, status, stop_reason = early_response
                self._commit_leftovers_before_finalize(
                    conversation=conversation,
                    turn_id=turn_id,
                    turn_items=turn_items,
                    stream_sink=stream_sink,
                )
                if status is not TurnStatus.WAITING_APPROVAL:
                    runtime._save_runtime_state(
                        conversation=conversation,
                        plan_state=current_plan_state,
                    )
                return runtime._finalize_response(
                    response=response,
                    turn_id=turn_id,
                    user_message=suspended.user_message,
                    started_at=started_at,
                    status=status,
                    stop_reason=stop_reason,
                    turn_items=turn_items,
                )

        return self._run_turn_loop(
            user_message=suspended.user_message,
            conversation=conversation,
            current_plan_state=current_plan_state,
            initial_in_progress_item_id=initial_in_progress_item_id,
            turn_id=turn_id,
            started_at=started_at,
            turn_items=turn_items,
            progress_updates=progress_updates,
            activity_events=activity_events,
            streamed_chunks=streamed_chunks,
            stream_sink=stream_sink,
            last_tool_exposure_summary=last_tool_exposure_summary,
            interrupt_token=interrupt_token,
        )

    def resolve_pending_clarification(
        self,
        *,
        request_id: str,
        response: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> TurnResponse:
        runtime = self._runtime
        _raise_if_interrupted(interrupt_token)
        normalized_response = response.strip()
        if not normalized_response:
            _record_clarification_resolution(
                runtime=runtime,
                turn_id=f"clarification_{uuid4().hex}",
                result="blank_response",
                request_id=request_id,
                response=normalized_response,
                pending=None,
            )
            return TurnResponse(assistant_message="Please provide a clarification response.")
        suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
        if suspended is None or suspended.pending_clarification is None:
            _record_clarification_resolution(
                runtime=runtime,
                turn_id=f"clarification_{uuid4().hex}",
                result="no_pending_clarification",
                request_id=request_id,
                response=normalized_response,
                pending=None,
            )
            return TurnResponse(assistant_message="There is no pending clarification to resolve.")
        pending = suspended.pending_clarification
        if pending.request_id != request_id:
            _record_clarification_resolution(
                runtime=runtime,
                turn_id=f"clarification_{uuid4().hex}",
                result="request_id_mismatch",
                request_id=request_id,
                response=normalized_response,
                pending=pending,
            )
            return TurnResponse(
                assistant_message="No pending clarification matches the provided request_id."
            )

        current_plan_state = suspended.plan_state
        turn_id = f"turn_{uuid4().hex}"
        runtime._set_current_turn_id(turn_id)
        started_at = runtime._event_ledger.timestamp()
        turn_items: list[TurnItem] = []
        _record_clarification_resolution(
            runtime=runtime,
            turn_id=turn_id,
            result="answered",
            request_id=request_id,
            response=normalized_response,
            pending=pending,
        )
        runtime._load_model_continuation_state(turn_id=turn_id)
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.CLARIFICATION_RESPONSE,
                text=normalized_response,
                tool_name=pending.tool_call.name,
                call_id=pending.tool_call.call_id,
                metadata={"request_id": pending.request_id},
            ),
        )
        tool_result_text = f"User answered clarification: {normalized_response}"
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.TOOL_RESULT,
                text=tool_result_text,
                tool_name=pending.tool_call.name,
                call_id=pending.tool_call.call_id,
                metadata={
                    "success": True,
                    "summary": "User answered clarification",
                    "error": None,
                    "raw_payload": {
                        "status": "answered",
                        "response": normalized_response,
                    },
                    "transcript_content": tool_result_text,
                },
            ),
        )
        conversation = Conversation(
            session_id=runtime._config.session_id,
            messages=list(suspended.conversation),
        )
        runtime._tool_execution_service.record_clarification_response(
            conversation,
            call=pending.tool_call,
            response=normalized_response,
        )
        runtime._save_runtime_state(
            conversation=conversation,
            plan_state=current_plan_state,
        )
        runtime._session_service.clear_suspended_turn(runtime._config.session_id)
        return self._run_turn_loop(
            user_message=suspended.user_message,
            conversation=conversation,
            current_plan_state=current_plan_state,
            initial_in_progress_item_id=current_plan_state.current_in_progress_item_id(),
            turn_id=turn_id,
            started_at=started_at,
            turn_items=turn_items,
            progress_updates=["[clarify] answered"],
            activity_events=[
                ActivityEvent(
                    kind="clarification_resolved",
                    message=f"answered clarification {pending.request_id}",
                    tool_name=pending.tool_call.name,
                )
            ],
            streamed_chunks=[],
            stream_sink=stream_sink,
            interrupt_token=interrupt_token,
        )

    def _run_turn_loop(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        current_plan_state: PlanState,
        initial_in_progress_item_id: str | None,
        turn_id: str,
        started_at: str,
        turn_items: list[TurnItem],
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        streamed_chunks: list[str],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
        last_tool_exposure_summary: dict[str, list[str]] | None = None,
        initial_runtime_reminders: tuple[str, ...] = (),
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> TurnResponse:
        runtime = self._runtime
        latest_context_baseline: ContextBaseline | None = None
        step_index = 0
        budget = ContextBudget(max_tokens=runtime._config.max_prompt_tokens)
        no_progress_tracker = NoProgressTracker()
        loop_state = LoopState()
        carryover_runtime_reminders: tuple[str, ...] = tuple(initial_runtime_reminders)
        fallback_model_active = False
        next_compact_phase = (
            CompactPhase.MID_TURN
            if conversation.messages and conversation.messages[-1].role == "tool"
            else CompactPhase.PRE_TURN
        )

        while True:
            try:
                _raise_if_interrupted(interrupt_token)
            except KeyboardInterrupt:
                return self._finalize_interrupted_turn(
                    user_message=user_message,
                    conversation=conversation,
                    current_plan_state=current_plan_state,
                    turn_id=turn_id,
                    started_at=started_at,
                    turn_items=turn_items,
                    latest_context_baseline=latest_context_baseline,
                    activity_events=activity_events,
                    streamed_chunks=streamed_chunks,
                    progress_updates=progress_updates,
                    stream_sink=stream_sink,
                    interrupt_token=interrupt_token,
                )
            self._drain_active_turn_input(
                conversation=conversation,
                turn_id=turn_id,
                turn_items=turn_items,
                progress_updates=progress_updates,
                activity_events=activity_events,
                stream_sink=stream_sink,
            )
            checkpoint_result = runtime._checkpoint.evaluate(
                step_index=step_index,
                conversation=conversation,
                plan_state=current_plan_state,
                no_progress_tracker=no_progress_tracker,
            )
            if checkpoint_result.exit_reason is not None:
                assistant_message = (
                    checkpoint_result.assistant_message
                    or "I stopped because this turn is no longer making progress."
                )
                runtime._append_turn_item(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    item=TurnItem(
                        type=TurnItemType.WARNING,
                        text=assistant_message,
                        metadata={
                            "exit_reason": checkpoint_result.exit_reason.value,
                            **(
                                {"guardrail": checkpoint_result.diagnostics}
                                if checkpoint_result.diagnostics
                                else {}
                            ),
                        },
                    ),
                )
                runtime._trace_service.append(
                    runtime._config.session_id,
                    RuntimeTraceEvent(
                        kind="guardrail",
                        turn_id=turn_id,
                        payload={
                            "exit_reason": checkpoint_result.exit_reason.value,
                            "stop_reason": (
                                checkpoint_result.stop_reason.value
                                if checkpoint_result.stop_reason is not None
                                else None
                            ),
                            "summary": assistant_message,
                            **checkpoint_result.diagnostics,
                        },
                    ),
                )
                self._commit_leftovers_before_finalize(
                    conversation=conversation,
                    turn_id=turn_id,
                    turn_items=turn_items,
                    stream_sink=stream_sink,
                )
                runtime._save_runtime_state(
                    conversation=conversation,
                    plan_state=current_plan_state,
                )
                return runtime._finalize_response(
                    response=TurnResponse(
                        assistant_message=assistant_message,
                        activity_events=tuple(activity_events),
                        streamed_chunks=tuple(streamed_chunks),
                        progress_updates=tuple(progress_updates),
                        plan_steps=runtime._planning_service.render_steps(current_plan_state),
                    ),
                    turn_id=turn_id,
                    user_message=user_message,
                    started_at=started_at,
                    status=TurnStatus.COMPLETED,
                    stop_reason=checkpoint_result.stop_reason,
                    turn_items=turn_items,
                    context_baseline=latest_context_baseline,
                )

            reasoning_effort = runtime._config.reasoning_effort
            runtime_reminders = tuple(
                dict.fromkeys(
                    (
                        *carryover_runtime_reminders,
                        *checkpoint_result.reminders,
                    )
                )
            )
            carryover_runtime_reminders = ()

            activity_events.append(
                ActivityEvent(
                    kind="thinking",
                    message="deciding next action",
                )
            )
            runtime._set_model_log_context(turn_id)
            runtime._set_model_runtime_event_recorder(turn_id)
            runtime._set_model_reasoning_effort(reasoning_effort)
            runtime._set_model_tool_choice(None)
            try:
                planned_exposure = runtime._plan_tool_exposure(
                    user_message=user_message,
                    conversation=conversation,
                    plan_state=current_plan_state,
                    interrupt_token=interrupt_token,
                )
            except KeyboardInterrupt:
                return self._finalize_interrupted_turn(
                    user_message=user_message,
                    conversation=conversation,
                    current_plan_state=current_plan_state,
                    turn_id=turn_id,
                    started_at=started_at,
                    turn_items=turn_items,
                    latest_context_baseline=latest_context_baseline,
                    activity_events=activity_events,
                    streamed_chunks=streamed_chunks,
                    progress_updates=progress_updates,
                    stream_sink=stream_sink,
                    interrupt_token=interrupt_token,
                )
            if planned_exposure.lifecycle_events:
                runtime._append_contributed_tool_lifecycle_events(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    activity_events=activity_events,
                    lifecycle_events=planned_exposure.lifecycle_events,
                )
            if planned_exposure.exposure.summary() != last_tool_exposure_summary:
                runtime._tool_orchestrator.append_tool_exposure_turn_item(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    activity_events=activity_events,
                    tool_exposure=planned_exposure.exposure,
                )
                last_tool_exposure_summary = planned_exposure.exposure.summary()
            tool_router = runtime._tool_orchestrator.build_tool_router(planned_exposure)
            conversation_for_model = conversation
            context, turn_context = runtime._assemble_turn_context(
                user_message=user_message,
                conversation=conversation_for_model,
                plan_state=current_plan_state,
                runtime_reminders=runtime_reminders,
                compaction_rehydration=CompactionRehydrationContext(),
                tool_exposure=planned_exposure.exposure,
            )
            contract = runtime._assemble_instruction_contract(
                turn_id=turn_id,
                context=context,
                turn_context=turn_context,
            )
            latest_context_baseline = runtime._context_baseline_from_contract(contract)
            tools = runtime._render_model_tools(
                tool_exposure=planned_exposure.exposure,
                tool_router=tool_router,
                allow_tools=True,
            )
            model_tool_exposure = planned_exposure.exposure
            request_shape = runtime._build_and_trace_request_shape(
                turn_id=turn_id,
                contract=contract,
                conversation=conversation_for_model,
                tools=tools,
            )
            sampling_phase = next_compact_phase
            try:
                compacted = self._maybe_compact_at_sampling_boundary(
                    conversation=conversation_for_model,
                    request_shape=request_shape,
                    tools=tools,
                    phase=sampling_phase,
                    turn_id=turn_id,
                    stream_sink=stream_sink,
                    activity_events=activity_events,
                )
            except KeyboardInterrupt:
                return self._finalize_interrupted_turn(
                    user_message=user_message,
                    conversation=conversation,
                    current_plan_state=current_plan_state,
                    turn_id=turn_id,
                    started_at=started_at,
                    turn_items=turn_items,
                    latest_context_baseline=latest_context_baseline,
                    activity_events=activity_events,
                    streamed_chunks=streamed_chunks,
                    progress_updates=progress_updates,
                    stream_sink=stream_sink,
                    interrupt_token=interrupt_token,
                )
            next_compact_phase = CompactPhase.PRE_TURN
            if compacted is not conversation_for_model:
                conversation_for_model = compacted
                conversation = conversation_for_model
                context, turn_context = runtime._assemble_turn_context(
                    user_message=user_message,
                    conversation=conversation_for_model,
                    plan_state=current_plan_state,
                    runtime_reminders=runtime_reminders,
                    compaction_rehydration=CompactionRehydrationContext(),
                    tool_exposure=planned_exposure.exposure,
                )
                contract = runtime._assemble_instruction_contract(
                    turn_id=turn_id,
                    context=context,
                    turn_context=turn_context,
                )
                latest_context_baseline = runtime._context_baseline_from_contract(contract)
                request_shape = runtime._build_and_trace_request_shape(
                    turn_id=turn_id,
                    contract=contract,
                    conversation=conversation_for_model,
                    tools=tools,
                )
            budget = runtime._estimate_request_window_budget(request_shape)
            runtime_reminders = BudgetNudge().apply(budget, runtime_reminders)
            runtime_items = runtime._request_pipeline.runtime_items(request_shape=request_shape)
            legacy_messages = runtime._request_pipeline.legacy_messages(request_shape=request_shape)
            conversation_checkpoint = len(conversation.messages)
            precommitted_items: list[RuntimeItem] = []

            def persist_completed_item(item: RuntimeItem) -> None:
                self._record_completed_item_conversation(
                    item=item,
                    conversation=conversation,
                    response_id=None,
                )
                precommitted_items.append(item)
                runtime._save_runtime_state(
                    conversation=conversation,
                    plan_state=current_plan_state,
                )

            try:
                _raise_if_interrupted(interrupt_token)
                request_started_at = runtime._monotonic()
                try:
                    turn_result, turn_streamed_chunks = (
                        runtime._model_turn_requester.request_model_turn(
                            runtime_items=runtime_items,
                            legacy_messages=legacy_messages,
                            tools=tools,
                            stream_sink=stream_sink,
                            completed_item_sink=persist_completed_item,
                            interrupt_token=interrupt_token,
                        )
                    )
                finally:
                    if fallback_model_active:
                        runtime._restore_model()
                        fallback_model_active = False
                if loop_state.transport_retries > 0:
                    self._emit_transient_stream_event(
                        stream_sink=stream_sink,
                        event=RuntimeStreamEvent(kind="stream_recovered"),
                        activity_events=activity_events,
                    )
                    loop_state = replace(loop_state, transport_retries=0)
                self._maybe_emit_heartbeat(
                    request_started_at=request_started_at,
                    progress_updates=progress_updates,
                    stream_sink=stream_sink,
                    activity_events=activity_events,
                )
                usage_payload = turn_result.metadata.get("usage")
                runtime._trace_cache_shape_diagnostic(
                    turn_id=turn_id,
                    request_shape=request_shape,
                    usage=usage_payload if isinstance(usage_payload, dict) else None,
                )
                runtime._record_provider_input_budget_metric(
                    usage=usage_payload if isinstance(usage_payload, dict) else None,
                    fallback_total_tokens=budget.total_tokens,
                    max_tokens=budget.max_tokens,
                )
                runtime._append_turn_item(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    item=TurnItem(
                        type=TurnItemType.MODEL_USAGE,
                        metadata=runtime._provider_input_budget_payload(
                            usage=usage_payload if isinstance(usage_payload, dict) else None,
                            fallback_total_tokens=budget.total_tokens,
                            max_tokens=budget.max_tokens,
                        ),
                    ),
                )
                streamed_chunks.extend(turn_streamed_chunks)
                runtime._persist_model_continuation_state(
                    turn_id=turn_id,
                    phase="model_turn_completed",
                )
            except ModelResponseError as exc:
                recovery_action = self._recovery_action_for_model_error(
                    exc=exc,
                    loop_state=loop_state,
                    runtime_reminders=runtime_reminders,
                )
                if recovery_action.metadata.get("recovery_error_class"):
                    runtime._trace_service.append(
                        runtime._config.session_id,
                        RuntimeTraceEvent(
                            kind="recovery_diagnostic",
                            turn_id=turn_id,
                            payload={
                                key: value
                                for key, value in recovery_action.metadata.items()
                                if key
                                in {
                                    "error_class",
                                    "recovery_error_class",
                                    "failure_kind",
                                    "stop_reason",
                                    "action",
                                    "will_retry",
                                    "attempt",
                                    "max_attempts",
                                    "recovery_kind",
                                }
                            },
                        ),
                    )
                if recovery_action.should_retry:
                    if precommitted_items:
                        del conversation.messages[conversation_checkpoint:]
                        runtime._save_runtime_state(
                            conversation=conversation,
                            plan_state=current_plan_state,
                        )
                        precommitted_items.clear()
                    loop_state = recovery_action.next_state
                    carryover_runtime_reminders = recovery_action.runtime_reminders
                    if recovery_action.fallback_model is not None:
                        runtime._set_model(recovery_action.fallback_model)
                        fallback_model_active = True
                    is_stream_retry = recovery_action.metadata.get("recovery_kind") == "retry"
                    if is_stream_retry:
                        try:
                            self._emit_stream_retry_lifecycle(
                                exc=exc,
                                action=recovery_action,
                                stream_sink=stream_sink,
                                activity_events=activity_events,
                            )
                        except KeyboardInterrupt:
                            return self._finalize_interrupted_turn(
                                user_message=user_message,
                                conversation=conversation,
                                current_plan_state=current_plan_state,
                                turn_id=turn_id,
                                started_at=started_at,
                                turn_items=turn_items,
                                latest_context_baseline=latest_context_baseline,
                                activity_events=activity_events,
                                streamed_chunks=streamed_chunks,
                                progress_updates=progress_updates,
                                stream_sink=stream_sink,
                                interrupt_token=interrupt_token,
                            )
                    else:
                        runtime._append_turn_item(
                            turn_id=turn_id,
                            turn_items=turn_items,
                            item=TurnItem(
                                type=TurnItemType.WARNING,
                                text=recovery_action.warning_text,
                                metadata=recovery_action.metadata,
                            ),
                        )
                        activity_events.append(
                            ActivityEvent(kind="model_error", message=recovery_action.warning_text)
                        )
                    if recovery_action.delay_seconds > 0:
                        if interrupt_token is None:
                            runtime._recovery_sleep(recovery_action.delay_seconds)
                        elif interrupt_token.wait(recovery_action.delay_seconds):
                            return self._finalize_interrupted_turn(
                                user_message=user_message,
                                conversation=conversation,
                                current_plan_state=current_plan_state,
                                turn_id=turn_id,
                                started_at=started_at,
                                turn_items=turn_items,
                                latest_context_baseline=latest_context_baseline,
                                activity_events=activity_events,
                                streamed_chunks=streamed_chunks,
                                progress_updates=progress_updates,
                                stream_sink=stream_sink,
                                interrupt_token=interrupt_token,
                            )
                    if recovery_action.invoke_pre_compact_hook:
                        runtime._hook_manager.execute(
                            HookPoint.PRE_COMPACT,
                            HookContext(
                                hook_point=HookPoint.PRE_COMPACT,
                                session_id=runtime._config.session_id,
                                metadata={
                                    "usage_ratio": budget.usage_ratio,
                                    "remaining_tokens": budget.remaining,
                                    "message_count": len(conversation.messages),
                                    "recovery_reason": exc.failure_kind
                                    or (
                                        exc.stop_reason.value if exc.stop_reason else "model_error"
                                    ),
                                    "recovery_retry": True,
                                },
                            ),
                        )
                        if not loop_state.reactive_compact_attempted:
                            before_reactive = conversation
                            reactive_budget = ContextBudget(
                                max_tokens=runtime._config.max_prompt_tokens,
                                total_tokens=runtime._config.max_prompt_tokens,
                            )
                            runtime._trace_before_compact(
                                turn_id=turn_id,
                                conversation=before_reactive,
                                budget=reactive_budget,
                                source="reactive_error",
                            )
                            reactive_decision = runtime._compact_trigger_policy.forced(
                                reason=CompactReason.CONTEXT_LIMIT,
                                phase=sampling_phase,
                                trigger_tokens=reactive_budget.total_tokens,
                            )
                            reactive_compacted = runtime._compact_active_history(
                                conversation,
                                decision=reactive_decision,
                                tools=tuple(tools),
                            )
                            reactive_cost_metrics: dict[str, int | float | str | list[str]] = {
                                "decision": (
                                    "summarize"
                                    if reactive_compacted is not conversation
                                    else runtime._compact_service.last_status
                                ),
                                "source": "reactive_error",
                                "reason": CompactReason.CONTEXT_LIMIT.value,
                                "phase": sampling_phase.value,
                            }
                            runtime._trace_after_compact(
                                turn_id=turn_id,
                                before_messages=before_reactive,
                                after_messages=reactive_compacted,
                                source="reactive_error",
                                cost_metrics=reactive_cost_metrics,
                            )
                            loop_state = LoopState(
                                context_window_retries=loop_state.context_window_retries,
                                transport_retries=loop_state.transport_retries,
                                context_recovery_stage="reactive_compact",
                                reactive_compact_attempted=True,
                                fallback_model_attempted=loop_state.fallback_model_attempted,
                                encrypted_reasoning_retries=loop_state.encrypted_reasoning_retries,
                            )
                            if reactive_compacted is not before_reactive:
                                conversation = reactive_compacted
                                runtime._record_compaction_metric(
                                    before_messages=before_reactive,
                                    after_messages=reactive_compacted,
                                )
                                runtime._record_l4_decision_metric(reactive_cost_metrics)
                    continue
                self._commit_leftovers_before_finalize(
                    conversation=conversation,
                    turn_id=turn_id,
                    turn_items=turn_items,
                    stream_sink=stream_sink,
                )
                if precommitted_items:
                    self._record_completed_items_before_interrupt(
                        turn_result=ModelTurnResult(
                            items=tuple(precommitted_items),
                            done=False,
                        ),
                        conversation=conversation,
                        turn_id=turn_id,
                        turn_items=turn_items,
                        progress_updates=progress_updates,
                        activity_events=activity_events,
                        conversation_items_recorded=True,
                    )
                return self._error_finalizer.finalize_model_error(
                    user_message=user_message,
                    current_plan_state=current_plan_state,
                    turn_id=turn_id,
                    started_at=started_at,
                    turn_items=turn_items,
                    latest_context_baseline=latest_context_baseline,
                    activity_events=activity_events,
                    progress_updates=progress_updates,
                    exc=exc,
                    phase="model_error",
                    stop_reason=exc.stop_reason or StopReason.MODEL_ERROR,
                    assistant_message=f"Model request failed: {exc}",
                )
            except ModelTurnInterrupted as exc:
                self._record_completed_items_before_interrupt(
                    turn_result=exc.completed_result,
                    conversation=conversation,
                    turn_id=turn_id,
                    turn_items=turn_items,
                    progress_updates=progress_updates,
                    activity_events=activity_events,
                    conversation_items_recorded=True,
                )
                return self._finalize_interrupted_turn(
                    user_message=user_message,
                    conversation=conversation,
                    current_plan_state=current_plan_state,
                    turn_id=turn_id,
                    started_at=started_at,
                    turn_items=turn_items,
                    latest_context_baseline=latest_context_baseline,
                    activity_events=activity_events,
                    streamed_chunks=streamed_chunks,
                    progress_updates=progress_updates,
                    stream_sink=stream_sink,
                    interrupt_token=interrupt_token,
                )
            except KeyboardInterrupt:
                return self._finalize_interrupted_turn(
                    user_message=user_message,
                    conversation=conversation,
                    current_plan_state=current_plan_state,
                    turn_id=turn_id,
                    started_at=started_at,
                    turn_items=turn_items,
                    latest_context_baseline=latest_context_baseline,
                    activity_events=activity_events,
                    streamed_chunks=streamed_chunks,
                    progress_updates=progress_updates,
                    stream_sink=stream_sink,
                    interrupt_token=interrupt_token,
                )
            except Exception as exc:  # pragma: no cover - guarded by focused tests
                if precommitted_items:
                    self._record_completed_items_before_interrupt(
                        turn_result=ModelTurnResult(
                            items=tuple(precommitted_items),
                            done=False,
                        ),
                        conversation=conversation,
                        turn_id=turn_id,
                        turn_items=turn_items,
                        progress_updates=progress_updates,
                        activity_events=activity_events,
                        conversation_items_recorded=True,
                    )
                self._commit_leftovers_before_finalize(
                    conversation=conversation,
                    turn_id=turn_id,
                    turn_items=turn_items,
                    stream_sink=stream_sink,
                )
                return self._error_finalizer.finalize_runtime_exception(
                    user_message=user_message,
                    current_plan_state=current_plan_state,
                    turn_id=turn_id,
                    started_at=started_at,
                    turn_items=turn_items,
                    latest_context_baseline=latest_context_baseline,
                    activity_events=activity_events,
                    progress_updates=progress_updates,
                    exc=exc,
                )

            try:
                (
                    current_plan_state,
                    turn_has_tool_call,
                    turn_text_chunks,
                    early_response,
                ) = runtime._assistant_block_consumer.consume_assistant_blocks(
                    turn_result=turn_result,
                    conversation=conversation,
                    tool_router=tool_router,
                    tool_exposure=model_tool_exposure,
                    plan_state=current_plan_state,
                    turn_id=turn_id,
                    user_message=user_message,
                    progress_updates=progress_updates,
                    activity_events=activity_events,
                    streamed_chunks=streamed_chunks,
                    turn_items=turn_items,
                    stream_sink=stream_sink,
                    conversation_items_precommitted=bool(precommitted_items),
                    interrupt_token=interrupt_token,
                )
            except KeyboardInterrupt:
                return self._finalize_interrupted_turn(
                    user_message=user_message,
                    conversation=conversation,
                    current_plan_state=current_plan_state,
                    turn_id=turn_id,
                    started_at=started_at,
                    turn_items=turn_items,
                    latest_context_baseline=latest_context_baseline,
                    activity_events=activity_events,
                    streamed_chunks=streamed_chunks,
                    progress_updates=progress_updates,
                    stream_sink=stream_sink,
                    interrupt_token=interrupt_token,
                )
            if early_response is not None:
                response, status, stop_reason = early_response
                self._commit_leftovers_before_finalize(
                    conversation=conversation,
                    turn_id=turn_id,
                    turn_items=turn_items,
                    stream_sink=stream_sink,
                )
                if status is not TurnStatus.WAITING_APPROVAL:
                    runtime._save_runtime_state(
                        conversation=conversation,
                        plan_state=current_plan_state,
                    )
                return runtime._finalize_response(
                    response=response,
                    turn_id=turn_id,
                    user_message=user_message,
                    started_at=started_at,
                    status=status,
                    stop_reason=stop_reason,
                    turn_items=turn_items,
                    context_baseline=latest_context_baseline,
                )

            if turn_has_tool_call:
                no_progress_tracker.update(conversation)
                step_index += 1
                next_compact_phase = CompactPhase.MID_TURN
                runtime._record_ptl_metric(
                    triggered=checkpoint_result.continue_reason
                    in {
                        ContinueReason.REROUTE,
                        ContinueReason.TRUNCATION_AWARE,
                    }
                )
                continue

            assistant_message = "".join(turn_text_chunks)
            if turn_result.done and assistant_message:
                if (
                    runtime.active_turn_mailbox_id() == turn_id
                    and runtime.active_turn_has_pending_input(turn_id)
                ):
                    step_index += 1
                    continue
                current_plan_state = runtime._planning_effects.complete_task_if_active(
                    current_plan_state,
                    initial_in_progress_item_id,
                )
                if runtime._hook_manager.has_hooks(HookPoint.STOP):
                    stop_hook_execution = runtime._hook_manager.execute_with_summary(
                        HookPoint.STOP,
                        HookContext(
                            hook_point=HookPoint.STOP,
                            session_id=runtime._config.session_id,
                            metadata={
                                "turn_id": turn_id,
                                "assistant_message_chars": len(assistant_message),
                            },
                        ),
                    )
                    stop_block = next(
                        (
                            hook_result
                            for hook_result in stop_hook_execution.results
                            if hook_result.action is HookAction.DENY
                        ),
                        None,
                    )
                    if stop_block is not None:
                        reminder = stop_block.message or "Stop hook requested continuation."
                        carryover_runtime_reminders = tuple(
                            dict.fromkeys(
                                (
                                    *carryover_runtime_reminders,
                                    f"Stop hook requested continuation: {reminder}",
                                )
                            )
                        )
                        progress_updates.append("[hook] stop blocked; continuing")
                        activity_events.append(
                            ActivityEvent(
                                kind="hook_blocked",
                                message="stop hook requested continuation",
                            )
                        )
                        step_index += 1
                        continue
                self._commit_leftovers_before_finalize(
                    conversation=conversation,
                    turn_id=turn_id,
                    turn_items=turn_items,
                    stream_sink=stream_sink,
                )
                runtime._save_runtime_state(
                    conversation=conversation,
                    plan_state=current_plan_state,
                )
                if runtime._config.memory_enabled:
                    runtime._memory_service.append_session_summary(
                        runtime._config.session_id,
                        assistant_message,
                    )
                    if runtime._config.memory_extraction_enabled:
                        runtime._memory_extraction_service.maybe_start_background_extraction(
                            MemoryExtractionRequest(
                                session_id=runtime._config.session_id,
                                turn_id=turn_id,
                                user_message=user_message,
                                assistant_message=assistant_message,
                                turn_items=tuple(turn_items),
                            )
                        )
                    if runtime._config.memory_dream_enabled:
                        runtime._memory_dream_service.maybe_start_background_dream(
                            MemoryDreamRequest(
                                session_id=runtime._config.session_id,
                                turn_id=turn_id,
                                recent_session_ids=(runtime._recent_session_ids_for_memory_dream()),
                                now=datetime.now(UTC),
                            )
                        )
                runtime._session_service.clear_pending_decision(runtime._config.session_id)
                runtime._session_service.clear_suspended_turn(runtime._config.session_id)
                return runtime._finalize_response(
                    response=TurnResponse(
                        assistant_message=assistant_message,
                        activity_events=tuple(activity_events),
                        streamed_chunks=tuple(streamed_chunks),
                        progress_updates=tuple(progress_updates),
                        plan_steps=runtime._planning_service.render_steps(current_plan_state),
                    ),
                    turn_id=turn_id,
                    user_message=user_message,
                    started_at=started_at,
                    status=TurnStatus.COMPLETED,
                    stop_reason=StopReason.ASSISTANT_COMPLETED,
                    turn_items=turn_items,
                    context_baseline=latest_context_baseline,
                )
            step_index += 1

    def _record_completed_items_before_interrupt(
        self,
        *,
        turn_result: ModelTurnResult,
        conversation: Conversation,
        turn_id: str,
        turn_items: list[TurnItem],
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        conversation_items_recorded: bool = False,
    ) -> None:
        runtime = self._runtime
        for item in turn_result.items:
            if item.role != "assistant":
                continue
            if not conversation_items_recorded:
                self._record_completed_item_conversation(
                    item=item,
                    conversation=conversation,
                    response_id=turn_result.response_id,
                )
            reasoning_blocks = tuple(block for block in item.blocks if block.type == "reasoning")
            text_blocks = tuple(block for block in item.blocks if block.type == "text")
            tool_blocks = tuple(block for block in item.blocks if block.type == "tool_call")

            for block in reasoning_blocks:
                if not block.text:
                    continue
                progress_updates.append(block.text)
                activity_kind = "planning" if "plan" in block.text.lower() else "thinking"
                activity_events.append(ActivityEvent(kind=activity_kind, message=block.text))
                runtime._append_turn_item(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    item=TurnItem(
                        type=TurnItemType.REASONING,
                        text=block.text,
                        metadata={
                            "activity_kind": activity_kind,
                            "provider_id": block.provider_id,
                            **block.metadata,
                        },
                    ),
                )

            combined_text = "".join(block.text or "" for block in text_blocks)
            if combined_text:
                last_text_block = text_blocks[-1]
                runtime._append_turn_item(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    item=TurnItem(
                        type=TurnItemType.ASSISTANT_MESSAGE,
                        text=combined_text,
                        metadata={
                            "provider_id": last_text_block.provider_id,
                            **last_text_block.metadata,
                        },
                    ),
                )

            if tool_blocks:
                for block in tool_blocks:
                    call = runtime._assistant_conversation_recorder.tool_call_from_block(block)
                    runtime._append_turn_item(
                        turn_id=turn_id,
                        turn_items=turn_items,
                        item=TurnItem(
                            type=TurnItemType.TOOL_CALL,
                            text=f"{call.name} call completed before interruption.",
                            tool_name=call.name,
                            call_id=call.call_id,
                            metadata={
                                **block.metadata,
                                "arguments": call.arguments,
                                "provider_id": block.provider_id,
                                "interrupted_before_execution": True,
                            },
                        ),
                    )
        runtime._event_ledger.persist_completed_turn_items(
            turn_id=turn_id,
            turn_items=turn_items,
        )

    def _record_completed_item_conversation(
        self,
        *,
        item: RuntimeItem,
        conversation: Conversation,
        response_id: str | None,
    ) -> None:
        if item.role != "assistant":
            return
        runtime = self._runtime
        text_blocks = tuple(block for block in item.blocks if block.type == "text")
        tool_blocks = tuple(block for block in item.blocks if block.type == "tool_call")
        if tool_blocks:
            runtime._assistant_conversation_recorder.record_tool_calls(
                conversation,
                tool_calls=tuple(
                    runtime._assistant_conversation_recorder.tool_call_from_block(block)
                    for block in tool_blocks
                ),
                blocks=tuple(block for block in item.blocks if block.type in {"text", "tool_call"}),
                response_id=response_id,
            )
            return
        combined_text = "".join(block.text or "" for block in text_blocks)
        if not combined_text:
            return
        last_text_block = text_blocks[-1]
        runtime._assistant_conversation_recorder.record_text_block(
            conversation,
            block=RuntimeBlock(
                type="text",
                text=combined_text,
                provider_id=last_text_block.provider_id,
                metadata=dict(last_text_block.metadata),
            ),
            response_id=response_id,
        )

    def _drain_active_turn_input(
        self,
        *,
        conversation: Conversation,
        turn_id: str,
        turn_items: list[TurnItem],
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
    ) -> None:
        runtime = self._runtime
        if runtime.active_turn_mailbox_id() != turn_id:
            return
        inputs = runtime.drain_active_turn_input(turn_id)
        try:
            if inputs:
                runtime._event_ledger.persist_completed_turn_items(
                    turn_id=turn_id,
                    turn_items=turn_items,
                )
            self._commit_user_inputs(
                inputs,
                conversation=conversation,
                turn_id=turn_id,
                turn_items=turn_items,
                stream_sink=stream_sink,
            )
        except Exception:
            runtime.close_active_turn_mailbox(turn_id)
            raise
        for notification in runtime.drain_task_notifications(turn_id):
            conversation.append(
                Message(
                    role="user",
                    content=notification.content,
                    blocks=self._user_message_blocks(
                        user_message=notification.content,
                        image_paths=(),
                    ),
                    metadata={
                        **notification.metadata,
                        "internal": True,
                        "source": "task_notification",
                    },
                )
            )
        drained = len(inputs)
        if drained == 0:
            return
        progress_updates.append(f"[steer] steering {drained}")
        activity_events.append(
            ActivityEvent(kind="steering", message=f"processing {drained} steering message(s)")
        )

    def _commit_user_inputs(
        self,
        inputs: tuple[UserMessageInput, ...],
        *,
        conversation: Conversation,
        turn_id: str,
        turn_items: list[TurnItem],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
    ) -> None:
        runtime = self._runtime
        for item in inputs:
            runtime._user_message_lifecycle.commit(
                turn_id=turn_id,
                item=item,
                conversation=conversation,
                turn_items=turn_items,
                stream_sink=stream_sink,
            )

    def _commit_leftovers_before_finalize(
        self,
        *,
        conversation: Conversation,
        turn_id: str,
        turn_items: list[TurnItem],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
    ) -> None:
        runtime = self._runtime
        if runtime.active_turn_mailbox_id() != turn_id:
            return
        leftovers = runtime.close_active_turn_mailbox(turn_id)
        if leftovers:
            runtime._event_ledger.persist_completed_turn_items(
                turn_id=turn_id,
                turn_items=turn_items,
            )
        self._commit_user_inputs(
            leftovers,
            conversation=conversation,
            turn_id=turn_id,
            turn_items=turn_items,
            stream_sink=stream_sink,
        )

    def _recovery_action_for_model_error(
        self,
        *,
        exc: ModelResponseError,
        loop_state: "LoopState",
        runtime_reminders: tuple[str, ...],
    ) -> "TurnRecoveryAction":
        failure_kind = exc.failure_kind or ""
        stop_reason = exc.stop_reason
        classification = ErrorClassifier().classify(exc)
        decision = RecoveryPolicy().decide(classification)

        if classification.error_class is RecoveryErrorClass.INVALID_ENCRYPTED_CONTENT:
            metadata = {
                "recovery_kind": RecoveryPolicyAction.STRIP_ENCRYPTED_REASONING_RETRY.value,
                "recovery_error_class": classification.error_class.value,
                **recovery_diagnostic_metadata(
                    classification=classification,
                    decision=decision,
                    attempt=loop_state.encrypted_reasoning_retries + 1,
                ),
            }
            if loop_state.encrypted_reasoning_retries >= 1:
                return TurnRecoveryAction(next_state=loop_state, metadata=metadata)
            self._runtime._session_service.save_responses_continuation_state(
                self._runtime._config.session_id,
                None,
            )
            continuation_setter = getattr(
                self._runtime._model_adapter,
                "set_continuation_state",
                None,
            )
            if callable(continuation_setter):
                continuation_setter(None)
            warning_text = (
                "Encrypted reasoning replay was rejected. Retrying once without "
                "provider-private encrypted replay state."
            )
            return TurnRecoveryAction(
                should_retry=True,
                warning_text=warning_text,
                runtime_reminders=runtime_reminders,
                next_state=LoopState(
                    context_window_retries=loop_state.context_window_retries,
                    transport_retries=loop_state.transport_retries,
                    context_recovery_stage=loop_state.context_recovery_stage,
                    reactive_compact_attempted=loop_state.reactive_compact_attempted,
                    fallback_model_attempted=loop_state.fallback_model_attempted,
                    encrypted_reasoning_retries=loop_state.encrypted_reasoning_retries + 1,
                ),
                metadata=metadata,
            )

        if classification.error_class is RecoveryErrorClass.CONTEXT_OVERFLOW:
            if loop_state.context_window_retries == 0:
                warning_text = "Context window exceeded. Retrying after draining redundant context."
                recovery_decision = RecoveryPolicy().decide(classification)
                return TurnRecoveryAction(
                    should_retry=True,
                    warning_text=warning_text,
                    runtime_reminders=tuple(
                        dict.fromkeys(
                            (
                                *runtime_reminders,
                                "Context window exceeded. Drain redundant tool output and retry using only distinct evidence.",
                            )
                        )
                    ),
                    next_state=LoopState(
                        context_window_retries=1,
                        transport_retries=loop_state.transport_retries,
                        context_recovery_stage="collapse_drain",
                        reactive_compact_attempted=loop_state.reactive_compact_attempted,
                        fallback_model_attempted=loop_state.fallback_model_attempted,
                        encrypted_reasoning_retries=loop_state.encrypted_reasoning_retries,
                    ),
                    metadata={
                        "recovery_kind": RecoveryPolicyAction.COMPACT_OR_SHRINK_RETRY.value,
                        "recovery_error_class": classification.error_class.value,
                        **recovery_diagnostic_metadata(
                            classification=classification,
                            decision=recovery_decision,
                            attempt=1,
                        ),
                    },
                )
            if loop_state.context_window_retries == 1:
                warning_text = (
                    "Context window still exceeded. Retrying once after reactive compaction."
                )
                recovery_decision = RecoveryPolicy().decide(classification)
                return TurnRecoveryAction(
                    should_retry=True,
                    warning_text=warning_text,
                    runtime_reminders=tuple(
                        dict.fromkeys(
                            (
                                *runtime_reminders,
                                "Reactive compaction applied. Answer with the most relevant remaining context and avoid expanding old tool output.",
                            )
                        )
                    ),
                    next_state=LoopState(
                        context_window_retries=2,
                        transport_retries=loop_state.transport_retries,
                        context_recovery_stage="reactive_compact",
                        reactive_compact_attempted=False,
                        fallback_model_attempted=loop_state.fallback_model_attempted,
                        encrypted_reasoning_retries=loop_state.encrypted_reasoning_retries,
                    ),
                    invoke_pre_compact_hook=True,
                    metadata={
                        "recovery_kind": RecoveryPolicyAction.COMPACT_OR_SHRINK_RETRY.value,
                        "recovery_error_class": classification.error_class.value,
                        **recovery_diagnostic_metadata(
                            classification=classification,
                            decision=recovery_decision,
                            attempt=2,
                        ),
                    },
                )
            if loop_state.context_window_retries >= 2:
                return TurnRecoveryAction(
                    next_state=loop_state,
                    metadata={
                        "recovery_kind": RecoveryPolicyAction.COMPACT_OR_SHRINK_RETRY.value,
                        "recovery_error_class": classification.error_class.value,
                        **recovery_diagnostic_metadata(
                            classification=classification,
                            decision=RecoveryPolicy().decide(classification),
                            attempt=loop_state.context_window_retries + 1,
                        ),
                    },
                )

        if is_transient_recovery_failure(
            failure_kind=failure_kind,
            is_retryable=exc.is_retryable or stop_reason is StopReason.TRANSPORT_FAILED,
        ):
            max_attempts = self._runtime._config.effective_stream_max_retries
            if loop_state.transport_retries >= max_attempts:
                fallback_model = self._runtime._config.fallback_model
                if fallback_model and not loop_state.fallback_model_attempted:
                    recovery_failure_kind = failure_kind or "transport_error"
                    warning_text = (
                        f"Retry budget exhausted. Trying fallback model {fallback_model}."
                    )
                    return TurnRecoveryAction(
                        should_retry=True,
                        warning_text=warning_text,
                        runtime_reminders=runtime_reminders,
                        next_state=LoopState(
                            context_window_retries=loop_state.context_window_retries,
                            transport_retries=loop_state.transport_retries,
                            context_recovery_stage=loop_state.context_recovery_stage,
                            reactive_compact_attempted=loop_state.reactive_compact_attempted,
                            fallback_model_attempted=True,
                            encrypted_reasoning_retries=loop_state.encrypted_reasoning_retries,
                        ),
                        fallback_model=fallback_model,
                        metadata=fallback_metadata(
                            from_model=self._runtime._config.model,
                            to_model=fallback_model,
                            failure_kind=recovery_failure_kind,
                        ),
                    )
                return TurnRecoveryAction(next_state=loop_state)
            attempt = loop_state.transport_retries + 1
            delay_seconds = RetryBackoffPolicy().delay_for_attempt(
                attempt,
                jitter_factor=self._runtime._retry_jitter(0.9, 1.1),
                retry_after_seconds=exc.retry_after_seconds,
            )
            recovery_failure_kind = failure_kind or "transport_error"
            warning_text = f"Reconnecting... {attempt}/{max_attempts}"
            return TurnRecoveryAction(
                should_retry=True,
                warning_text=warning_text,
                runtime_reminders=tuple(
                    dict.fromkeys(
                        (
                            *runtime_reminders,
                            "The previous model request failed due to a temporary transport issue. Continue from the existing context and avoid repeating completed work.",
                        )
                    )
                ),
                next_state=LoopState(
                    context_window_retries=loop_state.context_window_retries,
                    transport_retries=loop_state.transport_retries + 1,
                    context_recovery_stage=loop_state.context_recovery_stage,
                    reactive_compact_attempted=loop_state.reactive_compact_attempted,
                    fallback_model_attempted=loop_state.fallback_model_attempted,
                    encrypted_reasoning_retries=loop_state.encrypted_reasoning_retries,
                ),
                delay_seconds=delay_seconds,
                metadata=retry_metadata(
                    attempt=attempt,
                    max_attempts=max_attempts,
                    delay_seconds=delay_seconds,
                    failure_kind=recovery_failure_kind,
                ),
            )

        return TurnRecoveryAction(next_state=loop_state)

    def _emit_stream_retry_lifecycle(
        self,
        *,
        exc: ModelResponseError,
        action: "TurnRecoveryAction",
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
        activity_events: list[ActivityEvent],
    ) -> None:
        additional_details = " ".join(str(exc).split())[:2000]
        if exc.partial_output:
            self._emit_transient_stream_event(
                stream_sink=stream_sink,
                event=RuntimeStreamEvent(kind="stream_attempt_reset"),
                activity_events=activity_events,
            )
        self._emit_transient_stream_event(
            stream_sink=stream_sink,
            event=RuntimeStreamEvent(
                kind="stream_retrying",
                text=action.warning_text,
                metadata={
                    **action.metadata,
                    "max_retries": action.metadata.get("max_attempts", 0),
                    **({"additional_details": additional_details} if additional_details else {}),
                },
            ),
            activity_events=activity_events,
        )

    @staticmethod
    def _emit_transient_stream_event(
        *,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
        event: RuntimeStreamEvent,
        activity_events: list[ActivityEvent],
    ) -> None:
        if stream_sink is None:
            return
        try:
            stream_sink(event)
        except Exception:
            activity_events.append(
                ActivityEvent(kind="stream_sink_error", message="retry sink failed")
            )

    def _maybe_emit_heartbeat(
        self,
        *,
        request_started_at: float,
        progress_updates: list[str],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
        activity_events: list[ActivityEvent],
    ) -> None:
        runtime = self._runtime
        if not runtime._config.heartbeat_enabled:
            return
        elapsed = runtime._monotonic() - request_started_at
        if elapsed < runtime._config.heartbeat_interval_seconds:
            return
        message = "[heartbeat] model request still running"
        progress_updates.append(message)
        activity_events.append(ActivityEvent(kind="heartbeat", message=message))
        if stream_sink is None:
            return
        try:
            stream_sink(RuntimeStreamEvent(kind="heartbeat", text=message))
        except Exception:
            activity_events.append(
                ActivityEvent(kind="stream_sink_error", message="heartbeat sink failed")
            )

    def _emit_compaction_event(
        self,
        *,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
        activity_events: list[ActivityEvent],
        event_kind: str,
        source: str,
        before_tokens: int,
        after_tokens: int | None,
        max_tokens: int,
        status: str | None,
        duration_s: float | None,
        reason: str | None = None,
        phase: str | None = None,
    ) -> None:
        message = _compaction_activity_message(
            event_kind=event_kind,
            before_tokens=before_tokens,
            after_tokens=after_tokens,
            status=status,
            duration_s=duration_s,
        )
        activity_events.append(ActivityEvent(kind="compaction", message=message))
        if stream_sink is None:
            return
        metadata: dict[str, object] = {
            "source": source,
            "before_tokens": before_tokens,
            "max_tokens": max_tokens,
        }
        if after_tokens is not None:
            metadata["after_tokens"] = after_tokens
        if status is not None:
            metadata["status"] = status
        if duration_s is not None:
            metadata["duration_s"] = duration_s
        if reason is not None:
            metadata["reason"] = reason
        if phase is not None:
            metadata["phase"] = phase
        try:
            stream_sink(RuntimeStreamEvent(kind=event_kind, metadata=metadata))
        except Exception:
            activity_events.append(
                ActivityEvent(kind="stream_sink_error", message="compaction sink failed")
            )

    def _maybe_compact_at_sampling_boundary(
        self,
        *,
        conversation: Conversation,
        request_shape: RequestShape,
        tools: list[ModelToolDefinition],
        phase: CompactPhase,
        turn_id: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
        activity_events: list[ActivityEvent],
    ) -> Conversation:
        runtime = self._runtime
        token_status = runtime._compact_token_status(request_shape=request_shape)
        if phase is CompactPhase.MID_TURN:
            decision = runtime._compact_trigger_policy.mid_turn(token_status)
        else:
            decision = runtime._compact_trigger_policy.pre_turn(
                token_status,
                model_downshift=runtime._compact_model_downshift_pending,
                compatibility_changed=runtime._compact_compatibility_changed_pending,
            )
        if not decision.should_compact:
            return conversation

        source = decision.phase.value
        started_at = runtime._monotonic()
        before_budget = ContextBudget(
            max_tokens=decision.limit_tokens,
            total_tokens=decision.trigger_tokens,
        )
        runtime._trace_before_compact(
            turn_id=turn_id,
            conversation=conversation,
            budget=before_budget,
            source=source,
        )
        runtime._hook_manager.execute(
            HookPoint.PRE_COMPACT,
            HookContext(
                hook_point=HookPoint.PRE_COMPACT,
                session_id=runtime._config.session_id,
                metadata={
                    "reason": decision.reason.value if decision.reason is not None else "",
                    "phase": decision.phase.value,
                    "trigger_tokens": decision.trigger_tokens,
                    "limit_tokens": decision.limit_tokens,
                    "message_count": len(conversation.messages),
                },
            ),
        )
        self._emit_compaction_event(
            stream_sink=stream_sink,
            activity_events=activity_events,
            event_kind="compaction_started",
            source=source,
            before_tokens=decision.trigger_tokens,
            after_tokens=None,
            max_tokens=decision.limit_tokens,
            status=None,
            duration_s=None,
            reason=decision.reason.value if decision.reason is not None else None,
            phase=decision.phase.value,
        )
        compacted = runtime._compact_active_history(
            conversation,
            decision=decision,
            tools=tuple(tools),
        )
        after_tokens = runtime._estimated_conversation_tokens(compacted)
        status = runtime._compact_service.last_status
        self._emit_compaction_event(
            stream_sink=stream_sink,
            activity_events=activity_events,
            event_kind="compaction_completed",
            source=source,
            before_tokens=decision.trigger_tokens,
            after_tokens=after_tokens,
            max_tokens=decision.limit_tokens,
            status=status,
            duration_s=runtime._monotonic() - started_at,
            reason=decision.reason.value if decision.reason is not None else None,
            phase=decision.phase.value,
        )
        cost_metrics: dict[str, int | float | str | list[str]] = {
            "decision": "summarize" if compacted is not conversation else status,
            "source": source,
            "reason": decision.reason.value if decision.reason is not None else "",
            "phase": decision.phase.value,
            "trigger_tokens": decision.trigger_tokens,
            "limit_tokens": decision.limit_tokens,
            "removed_items": runtime._compact_service.last_removed_items,
            "retained_turns": runtime._compact_service.last_retained_turns,
            "summary_tokens": runtime._compact_service.last_summary_tokens,
        }
        runtime._record_compaction_metric(
            before_messages=conversation,
            after_messages=compacted,
        )
        runtime._record_l4_decision_metric(cost_metrics)
        runtime._trace_after_compact(
            turn_id=turn_id,
            before_messages=conversation,
            after_messages=compacted,
            source=source,
            cost_metrics=cost_metrics,
        )
        return compacted

    def _finalize_interrupted_turn(
        self,
        *,
        user_message: str,
        conversation: Conversation,
        current_plan_state: PlanState,
        turn_id: str,
        started_at: str,
        turn_items: list[TurnItem],
        latest_context_baseline: ContextBaseline | None,
        activity_events: list[ActivityEvent],
        streamed_chunks: list[str],
        progress_updates: list[str],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
        interrupt_token: RuntimeInterruptToken | None = None,
    ) -> TurnResponse:
        runtime = self._runtime
        interrupt_warning = (
            "Turn interrupted. The current turn was aborted; send a new message to continue."
        )
        input_rolled_back = bool(
            interrupt_token is not None
            and interrupt_token.rollback_user_input
            and not _has_visible_turn_activity(turn_items)
        )
        if input_rolled_back:
            if runtime.active_turn_mailbox_id() == turn_id:
                runtime.close_active_turn_mailbox(turn_id)
        else:
            self._commit_leftovers_before_finalize(
                conversation=conversation,
                turn_id=turn_id,
                turn_items=turn_items,
                stream_sink=stream_sink,
            )
        runtime._persist_model_continuation_state(
            turn_id=turn_id,
            phase="interrupted",
        )
        if input_rolled_back:
            _rollback_conversation_turn(
                conversation,
                turn_id=turn_id,
                user_message=user_message,
            )
            runtime._session_service.rollback_history_turn(
                runtime._config.session_id,
                turn_id=turn_id,
            )
            runtime._save_runtime_state(
                conversation=conversation,
                plan_state=current_plan_state,
            )
            _record_turn_interrupted(
                runtime=runtime,
                turn_id=turn_id,
                message_count=len(conversation.messages),
                input_rolled_back=True,
            )
            return runtime._finalize_response(
                response=TurnResponse(
                    assistant_message="",
                    activity_events=tuple(activity_events),
                    streamed_chunks=tuple(streamed_chunks),
                    progress_updates=tuple(progress_updates),
                    plan_steps=runtime._planning_service.render_steps(current_plan_state),
                    input_rolled_back=True,
                ),
                turn_id=turn_id,
                user_message=user_message,
                started_at=started_at,
                status=TurnStatus.INTERRUPTED,
                stop_reason=StopReason.INTERRUPTED,
                turn_items=turn_items,
                context_baseline=latest_context_baseline,
            )
        activity_events.append(ActivityEvent(kind="model_error", message=interrupt_warning))
        repaired_tool_results = _repair_interrupted_tool_results(conversation)
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.WARNING,
                text=interrupt_warning,
                metadata={"event_kind": "turn_aborted_marker"},
            ),
        )
        for repaired in repaired_tool_results:
            runtime._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.TOOL_RESULT,
                    text=repaired.content,
                    call_id=repaired.tool_call_id,
                    metadata={
                        "success": False,
                        "error_kind": "tool_interrupted",
                        "synthetic": True,
                        "recovery_kind": "interrupted_missing_tool_result",
                    },
                ),
            )
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.USER_MESSAGE,
                text=INTERRUPTED_TURN_MARKER,
                metadata={
                    "event_kind": "turn_aborted_marker",
                    "interrupted_turn_id": turn_id,
                    "model_role": "developer",
                },
            ),
        )
        conversation.append(
            Message(
                role="developer",
                content=INTERRUPTED_TURN_MARKER,
                metadata={
                    "event_kind": "turn_aborted_marker",
                    "interrupted_turn_id": turn_id,
                    "model_role": "developer",
                },
            ),
        )
        runtime._save_runtime_state(
            conversation=conversation,
            plan_state=current_plan_state,
        )
        _record_turn_interrupted(
            runtime=runtime,
            turn_id=turn_id,
            message_count=len(conversation.messages),
        )
        return runtime._finalize_response(
            response=TurnResponse(
                assistant_message=interrupt_warning,
                activity_events=tuple(activity_events),
                streamed_chunks=tuple(streamed_chunks),
                progress_updates=tuple(progress_updates),
                plan_steps=runtime._planning_service.render_steps(current_plan_state),
            ),
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=TurnStatus.INTERRUPTED,
            stop_reason=StopReason.INTERRUPTED,
            turn_items=turn_items,
            context_baseline=latest_context_baseline,
        )


@dataclass(slots=True, frozen=True)
class LoopState:
    context_window_retries: int = 0
    transport_retries: int = 0
    context_recovery_stage: str | None = None
    reactive_compact_attempted: bool = False
    fallback_model_attempted: bool = False
    encrypted_reasoning_retries: int = 0


@dataclass(slots=True, frozen=True)
class TurnRecoveryAction:
    should_retry: bool = False
    warning_text: str = ""
    runtime_reminders: tuple[str, ...] = ()
    next_state: LoopState = LoopState()
    invoke_pre_compact_hook: bool = False
    fallback_model: str | None = None
    delay_seconds: float = 0.0
    metadata: dict[str, object] = field(default_factory=dict)


def _record_approval_allowance(
    *,
    runtime: AgentRuntime,
    turn_id: str,
    decision: PendingDecision,
    new_allowance: bool,
) -> None:
    payload: dict[str, object] = {
        "action": DecisionAction.ALLOW_SESSION.value,
        "tool_name": decision.tool_call.name,
        "call_id": decision.tool_call.call_id,
        "command_pattern": decision.command_pattern,
        "decision_id": decision.tool_call.call_id or "decision_current",
        "new_allowance": new_allowance,
        "reason": decision.reason,
    }
    safety = runtime._approval_service._safety_policy.evaluate(decision.tool_call)
    if safety.metadata:
        payload["safety_metadata"] = safety.metadata
    runtime._trace_service.append(
        runtime._config.session_id,
        RuntimeTraceEvent(kind="approval_allowance", turn_id=turn_id, payload=payload),
    )
    runtime._workspace_log_service.log(
        level=LogLevel.INFO,
        event="approval_allowance",
        message=f"Allowed {decision.tool_call.name} for this session.",
        context=payload,
    )


def _record_persistent_approval(
    *,
    runtime: AgentRuntime,
    turn_id: str,
    decision: PendingDecision,
    write_result: ExecPolicyWriteResult,
) -> None:
    payload: dict[str, object] = {
        "action": DecisionAction.ALWAYS_ALLOW.value,
        "shell_kind": _decision_shell_kind(decision).value,
        "rule_source": "user",
        "pattern_token_count": len(decision.proposed_execpolicy_pattern or ()),
        "pattern_hash": write_result.pattern_hash,
        "write_result": write_result.status,
    }
    runtime._trace_service.append(
        runtime._config.session_id,
        RuntimeTraceEvent(
            kind="persistent_approval",
            turn_id=turn_id,
            payload=payload,
        ),
    )
    runtime._workspace_log_service.log(
        level=LogLevel.INFO,
        event="persistent_approval",
        message="Persisted a global Shell approval rule.",
        context=payload,
    )


def _record_persistent_approval_failure(
    *,
    runtime: AgentRuntime,
    turn_id: str,
    decision: PendingDecision,
    stage: str,
    error: Exception,
) -> None:
    payload: dict[str, object] = {
        "action": DecisionAction.ALWAYS_ALLOW.value,
        "stage": stage,
        "error_kind": type(error).__name__,
        "validated_pattern": decision.proposed_execpolicy_pattern is not None,
    }
    runtime._trace_service.append(
        runtime._config.session_id,
        RuntimeTraceEvent(
            kind="persistent_approval_failed",
            turn_id=turn_id,
            payload=payload,
        ),
    )
    runtime._workspace_log_service.log(
        level=LogLevel.WARNING,
        event="persistent_approval_failed",
        message="Could not activate a global Shell approval rule.",
        context=payload,
    )


def _decision_shell_kind(decision: PendingDecision) -> ShellKind:
    value = decision.metadata.get("shell_kind", ShellKind.BASH.value)
    try:
        return ShellKind(str(value))
    except ValueError:
        return ShellKind.BASH


def _record_approval_recovery(
    *,
    runtime: AgentRuntime,
    turn_id: str,
    result: str,
    pending_decision: bool,
    suspended_turn: bool,
    pending_approval: bool,
    decision: PendingDecision | None,
) -> None:
    payload: dict[str, object] = {
        "result": result,
        "pending_decision": pending_decision,
        "suspended_turn": suspended_turn,
        "pending_approval": pending_approval,
        "option_count": len(decision.options) if decision is not None else 0,
        "command_pattern_present": bool(decision and decision.command_pattern),
    }
    if decision is not None:
        payload.update(
            {
                "tool_name": decision.tool_call.name,
                "call_id": decision.tool_call.call_id,
                "decision_id": decision.tool_call.call_id or "decision_current",
            }
        )
    runtime._trace_service.append(
        runtime._config.session_id,
        RuntimeTraceEvent(kind="approval_recovery", turn_id=turn_id, payload=payload),
    )
    runtime._workspace_log_service.log(
        level=LogLevel.INFO,
        event="approval_recovery",
        message=f"Approval recovery {result}.",
        context=payload,
    )


def _record_approval_resolution(
    *,
    runtime: AgentRuntime,
    turn_id: str,
    result: str,
    choice: str,
    decision: PendingDecision | None,
) -> None:
    payload = _approval_resolution_payload(
        result=result,
        choice=choice,
        decision=decision,
    )
    runtime._trace_service.append(
        runtime._config.session_id,
        RuntimeTraceEvent(kind="approval_resolution", turn_id=turn_id, payload=payload),
    )
    runtime._workspace_log_service.log(
        level=LogLevel.INFO,
        event="approval_resolution",
        message=f"Approval resolution {result}.",
        context=payload,
    )


def _approval_resolution_payload(
    *,
    result: str,
    choice: str,
    decision: PendingDecision | None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "result": result,
        "choice": choice[:80],
    }
    if decision is None:
        return payload
    payload.update(
        {
            "tool_name": decision.tool_call.name,
            "call_id": decision.tool_call.call_id,
            "decision_id": decision.tool_call.call_id or "decision_current",
            "command_pattern": decision.command_pattern,
            "reason": decision.reason,
        }
    )
    return payload


def _record_clarification_resolution(
    *,
    runtime: AgentRuntime,
    turn_id: str,
    result: str,
    request_id: str,
    response: str,
    pending: PendingClarification | None,
) -> None:
    payload = _clarification_resolution_payload(
        result=result,
        request_id=request_id,
        response=response,
        pending=pending,
    )
    level = LogLevel.INFO if result == "answered" else LogLevel.WARNING
    runtime._trace_service.append(
        runtime._config.session_id,
        RuntimeTraceEvent(kind="clarification_resolution", turn_id=turn_id, payload=payload),
    )
    runtime._workspace_log_service.log(
        level=level,
        event="clarification_resolution",
        message=f"Clarification resolution {result}.",
        context=payload,
    )


def _clarification_resolution_payload(
    *,
    result: str,
    request_id: str,
    response: str,
    pending: PendingClarification | None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "result": result,
        "request_id": request_id[:120],
        "response_chars": len(response),
    }
    if pending is None:
        return payload
    payload.update(
        {
            "expected_request_id": pending.request_id,
            "tool_name": pending.tool_call.name,
            "call_id": pending.tool_call.call_id,
        }
    )
    return payload


INTERRUPTED_TOOL_RESULT_CONTENT = "Tool call interrupted by user before it completed."


def _unresolved_tool_call_items_for_current_turn(
    conversation: Conversation,
) -> tuple[RuntimeItem, ...]:
    current_turn_start = 0
    for index, message in enumerate(conversation.messages):
        if message.role == "user":
            current_turn_start = index

    current_messages = conversation.messages[current_turn_start:]
    resolved_call_ids = {
        message.tool_call_id
        for message in current_messages
        if message.role == "tool" and message.tool_call_id
    }
    queued_call_ids: set[str] = set()
    items: list[RuntimeItem] = []
    for message in current_messages:
        if message.role != "assistant" or not message.tool_calls:
            continue
        blocks_by_call_id = {
            block.call_id: block
            for block in message.blocks
            if block.type == "tool_call" and block.call_id
        }
        pending_blocks: list[RuntimeBlock] = []
        for call in message.tool_calls:
            call_id = call.call_id
            if not call_id or call_id in resolved_call_ids or call_id in queued_call_ids:
                continue
            queued_call_ids.add(call_id)
            pending_blocks.append(
                blocks_by_call_id.get(call_id)
                or RuntimeBlock(
                    type="tool_call",
                    tool_name=call.name,
                    tool_arguments=dict(call.arguments),
                    call_id=call_id,
                )
            )
        if pending_blocks:
            items.append(
                RuntimeItem(
                    role="assistant",
                    blocks=tuple(pending_blocks),
                    metadata=dict(message.metadata),
                )
            )
    return tuple(items)


def _repair_interrupted_tool_results(conversation: Conversation) -> tuple[Message, ...]:
    pending_tool_call_ids: list[str] = []
    for message in conversation.messages:
        if message.role == "assistant":
            for call in message.tool_calls:
                call_id = call.call_id
                if isinstance(call_id, str) and call_id and call_id not in pending_tool_call_ids:
                    pending_tool_call_ids.append(call_id)
            continue
        if message.role == "tool":
            tool_call_id = message.tool_call_id
            if isinstance(tool_call_id, str) and tool_call_id in pending_tool_call_ids:
                pending_tool_call_ids.remove(tool_call_id)

    repaired: list[Message] = []
    for tool_call_id in pending_tool_call_ids:
        message = Message(
            role="tool",
            content=INTERRUPTED_TOOL_RESULT_CONTENT,
            tool_call_id=tool_call_id,
            blocks=(
                RuntimeBlock(
                    type="tool_result",
                    text=INTERRUPTED_TOOL_RESULT_CONTENT,
                    call_id=tool_call_id,
                    metadata={
                        "success": False,
                        "error_kind": "tool_interrupted",
                        "synthetic": True,
                    },
                ),
            ),
            metadata={
                "success": False,
                "error_kind": "tool_interrupted",
                "synthetic": True,
                "append_only": True,
            },
        )
        conversation.append(message)
        repaired.append(message)
    return tuple(repaired)


_VISIBLE_TURN_ITEM_TYPES = {
    TurnItemType.ASSISTANT_MESSAGE,
    TurnItemType.TOOL_CALL,
    TurnItemType.TOOL_RESULT,
    TurnItemType.APPROVAL_REQUEST,
    TurnItemType.APPROVAL_RESOLUTION,
    TurnItemType.CLARIFICATION_REQUEST,
    TurnItemType.CLARIFICATION_RESPONSE,
    TurnItemType.PLAN_UPDATE,
    TurnItemType.WARNING,
}


def _has_visible_turn_activity(turn_items: list[TurnItem]) -> bool:
    return any(item.type in _VISIBLE_TURN_ITEM_TYPES for item in turn_items)


def _rollback_conversation_turn(
    conversation: Conversation,
    *,
    turn_id: str,
    user_message: str,
) -> None:
    rollback_index: int | None = None
    for index in range(len(conversation.messages) - 1, -1, -1):
        message = conversation.messages[index]
        if message.role != "user":
            continue
        if message.metadata.get("turn_id") == turn_id:
            rollback_index = index
            break
        if message.content == user_message:
            rollback_index = index
            break
    if rollback_index is not None:
        del conversation.messages[rollback_index:]


def _record_turn_interrupted(
    *,
    runtime: AgentRuntime,
    turn_id: str,
    message_count: int,
    input_rolled_back: bool = False,
) -> None:
    payload = {
        "session_id": runtime._config.session_id,
        "turn_id": turn_id,
        "stop_reason": StopReason.INTERRUPTED.value,
        "history_marker": not input_rolled_back,
        "saved_state": False,
        "message_count": message_count,
    }
    if input_rolled_back:
        payload["input_rolled_back"] = True
    runtime._trace_service.append(
        runtime._config.session_id,
        RuntimeTraceEvent(kind="turn_interrupted", turn_id=turn_id, payload=payload),
    )
    runtime._workspace_log_service.log(
        level=LogLevel.WARNING,
        event="turn_interrupted",
        message="Turn interrupted and recorded as aborted.",
        context=payload,
    )


def _is_legacy_interrupted_snapshot(suspended: SuspendedTurn) -> bool:
    return (
        suspended.suspend_reason is StopReason.INTERRUPTED
        and suspended.pending_approval is None
        and suspended.pending_clarification is None
    )


def _compaction_activity_message(
    *,
    event_kind: str,
    before_tokens: int,
    after_tokens: int | None,
    status: str | None,
    duration_s: float | None,
) -> str:
    if event_kind == "compaction_started":
        return f"Compressing context ({before_tokens:,} tokens)"
    duration = "" if duration_s is None else f" for {_format_seconds(duration_s)}"
    if status == "failed":
        return f"Context compression failed{duration}"
    if status == "skipped":
        return f"Context compression skipped{duration}"
    if after_tokens is None:
        return f"Context compressed{duration}"
    return f"Context compressed{duration}: {before_tokens:,} -> {after_tokens:,} tokens"


def _format_seconds(value: float) -> str:
    rounded = round(value, 1) if value < 10 else round(value)
    return f"{rounded:g} s"


@dataclass(slots=True, frozen=True)
class BudgetNudge:
    warning_threshold: float = 0.6
    force_answer_threshold: float = 0.85

    def apply(
        self,
        budget: ContextBudget,
        runtime_reminders: tuple[str, ...],
    ) -> tuple[str, ...]:
        reminders = list(runtime_reminders)

        if budget.usage_ratio >= self.warning_threshold:
            warning = f"Turn budget is above 60% ({budget.total_tokens}/{budget.max_tokens} tokens, about {budget.remaining} remaining). Prefer shorter reasoning and only essential tool calls."
            if warning not in reminders:
                reminders.append(warning)

        if budget.usage_ratio >= self.force_answer_threshold:
            warning = f"Turn budget is above 85% ({budget.total_tokens}/{budget.max_tokens} tokens, about {budget.remaining} remaining). If you have enough evidence, answer now and avoid more tool calls."
            if warning not in reminders:
                reminders.append(warning)

        return tuple(reminders)


def _hook_additional_contexts(results: tuple[HookResult, ...]) -> tuple[str, ...]:
    contexts: list[str] = []
    for result in results:
        contexts.extend(
            f"[hook:user_prompt_submit] {context}" for context in result.additional_contexts
        )
    return tuple(dict.fromkeys(context for context in contexts if context.strip()))


def _raise_if_interrupted(interrupt_token: RuntimeInterruptToken | None) -> None:
    if interrupt_token is not None:
        interrupt_token.raise_if_interrupted()

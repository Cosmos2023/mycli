from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from uuid import uuid4

from mycli.application.runtime.recovery import (
    RetryBackoffPolicy,
    is_transient_recovery_failure,
    retry_metadata,
)
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    ActivityEvent,
    ContextBaseline,
    DecisionAction,
    PlanState,
    RuntimeStreamEvent,
    SessionCommandAllowance,
    StopReason,
    SuspendedTurn,
    TurnItem,
    TurnItemType,
    TurnResponse,
    TurnStatus,
)
from mycli.application.runtime.turn_error_finalizer import TurnErrorFinalizer
from mycli.services.context.compaction import CacheZones, ContextBudget
from mycli.services.hooks import HookContext, HookPoint
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.services.turn_guard import ContinueReason, NoProgressTracker

if TYPE_CHECKING:
    from mycli.application.runtime.agent_runtime import AgentRuntime


class TurnExecutor:
    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime
        self._error_finalizer = TurnErrorFinalizer(runtime)

    def execute_user_turn(
        self,
        user_message: str,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> TurnResponse:
        runtime = self._runtime
        decision = runtime._session_service.load_pending_decision(runtime._config.session_id)
        if decision is not None:
            return TurnResponse(
                assistant_message=(
                    "There is a pending risky action waiting for your decision. "
                    f"Please choose {runtime._format_allowed_choices(decision.options)}."
                ),
                pending_decision=decision,
            )
        suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
        if suspended is not None and suspended.pending_approval is not None:
            pending_decision = runtime._pending_decision_from_approval(
                suspended.pending_approval
            )
            return TurnResponse(
                assistant_message=(
                    "There is a pending risky action waiting for your decision. "
                    f"Please choose {runtime._format_allowed_choices(pending_decision.options)}."
                ),
                pending_decision=pending_decision,
            )
        if suspended is not None:
            return self._resume_interrupted_turn(suspended)

        conversation = runtime._session_service.load_conversation(runtime._config.session_id)
        current_plan_state = runtime._session_service.load_plan_state(runtime._config.session_id)
        initial_in_progress_item_id = current_plan_state.current_in_progress_item_id()
        turn_id = f"turn_{uuid4().hex}"
        runtime._set_current_turn_id(turn_id)
        started_at = runtime._timestamp()
        turn_items: list[TurnItem] = []
        runtime._load_model_continuation_state(turn_id=turn_id)
        conversation.append(Message(role="user", content=user_message))
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(type=TurnItemType.USER_MESSAGE, text=user_message),
        )
        return self._run_turn_loop(
            user_message=user_message,
            conversation=conversation,
            current_plan_state=current_plan_state,
            initial_in_progress_item_id=initial_in_progress_item_id,
            turn_id=turn_id,
            started_at=started_at,
            turn_items=turn_items,
            progress_updates=[],
            activity_events=[],
            streamed_chunks=[],
            stream_sink=stream_sink,
        )

    def _resume_interrupted_turn(self, suspended: SuspendedTurn) -> TurnResponse:
        runtime = self._runtime
        runtime._session_service.clear_suspended_turn(runtime._config.session_id)
        current_plan_state = suspended.plan_state
        turn_id = f"turn_{uuid4().hex}"
        runtime._set_current_turn_id(turn_id)
        started_at = runtime._timestamp()
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

    def resolve_pending_approval(self, choice: str) -> TurnResponse:
        runtime = self._runtime
        decision = runtime._session_service.load_pending_decision(runtime._config.session_id)
        if decision is None:
            return TurnResponse(assistant_message="There is no pending decision to resolve.")

        normalized = choice.strip()
        choice_to_action = {
            "1": DecisionAction.APPROVE_ONCE,
            "2": DecisionAction.REJECT,
            "3": DecisionAction.ALLOW_SESSION,
        }
        allowed_choices = tuple(
            key for key, action in choice_to_action.items() if action in decision.options
        )
        if normalized not in allowed_choices:
            return TurnResponse(
                assistant_message=(
                    f"Please choose {runtime._format_allowed_choices(decision.options)}."
                ),
                pending_decision=decision,
            )

        selected_action = choice_to_action[normalized]
        if selected_action is DecisionAction.ALLOW_SESSION and not decision.command_pattern:
            return TurnResponse(
                assistant_message=(
                    f"Please choose {runtime._format_allowed_choices(decision.options)}."
                ),
                pending_decision=decision,
            )

        suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
        if suspended is None:
            suspended = runtime._session_service.reconstruct_suspended_turn(
                runtime._config.session_id,
                decision,
            )

        current_plan_state = runtime._session_service.load_plan_state(runtime._config.session_id)
        turn_id = f"turn_{uuid4().hex}"
        runtime._set_current_turn_id(turn_id)
        started_at = runtime._timestamp()
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
            runtime._session_service.clear_pending_decision(runtime._config.session_id)
            runtime._session_service.clear_suspended_turn(runtime._config.session_id)
            message = f"Rejected {decision.tool_call.name}. Pending decision cleared."
            runtime._memory_service.append_session_summary(runtime._config.session_id, message)
            user_message = suspended.user_message if suspended is not None else ""
            return runtime._finalize_response(
                response=TurnResponse(
                    assistant_message=message,
                    progress_updates=("[decision] rejected",),
                ),
                turn_id=turn_id,
                user_message=user_message,
                started_at=started_at,
                status=TurnStatus.COMPLETED,
                stop_reason=StopReason.ASSISTANT_COMPLETED,
                turn_items=turn_items,
            )

        if suspended is None or suspended.pending_approval is None:
            return TurnResponse(
                assistant_message=(
                    "The pending decision exists, but the suspended turn cannot be resumed."
                ),
                pending_decision=decision,
            )

        if (
            selected_action is DecisionAction.ALLOW_SESSION
            and decision.command_pattern
        ):
            runtime._session_service.add_command_allowance(
                runtime._config.session_id,
                SessionCommandAllowance(command_pattern=decision.command_pattern),
            )

        runtime._session_service.clear_pending_decision(runtime._config.session_id)
        runtime._session_service.clear_suspended_turn(runtime._config.session_id)

        approved_call = runtime._normalize_tool_call(suspended.pending_approval.tool_call)
        conversation = Conversation(
            session_id=runtime._config.session_id,
            messages=list(suspended.conversation),
        )
        initial_in_progress_item_id = current_plan_state.current_in_progress_item_id()
        runtime._load_model_continuation_state(turn_id=turn_id)
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(type=TurnItemType.USER_MESSAGE, text=suspended.user_message),
        )
        progress_updates = ["[decision] approved"]
        activity_events: list[ActivityEvent] = []
        streamed_chunks: list[str] = []
        initial_planned_exposure = runtime._plan_tool_exposure(
            user_message=suspended.user_message,
            conversation=conversation,
            plan_state=current_plan_state,
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
            runtime._append_tool_exposure_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                activity_events=activity_events,
                tool_exposure=initial_planned_exposure.exposure,
            )
            last_tool_exposure_summary = initial_planned_exposure.exposure.summary()
        initial_tool_router = runtime._build_tool_router(initial_planned_exposure)
        current_plan_state = runtime._execute_tool_call(
            conversation=conversation,
            call=approved_call,
            tool_router=initial_tool_router,
            tool_exposure=initial_planned_exposure.exposure,
            plan_state=current_plan_state,
            turn_id=turn_id,
            activity_events=activity_events,
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
            last_tool_exposure_summary=last_tool_exposure_summary,
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
    ) -> TurnResponse:
        runtime = self._runtime
        latest_context_baseline: ContextBaseline | None = None
        step_index = 0
        budget = ContextBudget(max_tokens=runtime._config.max_prompt_tokens)
        no_progress_tracker = NoProgressTracker()
        loop_state = LoopState()
        carryover_runtime_reminders: tuple[str, ...] = ()

        while True:
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
                        metadata={"exit_reason": checkpoint_result.exit_reason.value},
                    ),
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
            planned_exposure = runtime._plan_tool_exposure(
                user_message=user_message,
                conversation=conversation,
                plan_state=current_plan_state,
            )
            if planned_exposure.lifecycle_events:
                runtime._append_contributed_tool_lifecycle_events(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    activity_events=activity_events,
                    lifecycle_events=planned_exposure.lifecycle_events,
                )
            if planned_exposure.exposure.summary() != last_tool_exposure_summary:
                runtime._append_tool_exposure_turn_item(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    activity_events=activity_events,
                    tool_exposure=planned_exposure.exposure,
                )
                last_tool_exposure_summary = planned_exposure.exposure.summary()
            tool_router = runtime._build_tool_router(planned_exposure)
            conversation_before_compaction = conversation
            pre_compaction_budget = runtime._estimate_window_budget(conversation)
            try:
                conversation_for_model = runtime._compaction_pipeline.apply(
                    conversation,
                    pre_compaction_budget,
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
                )
            runtime._record_compaction_metric(
                before_messages=conversation_before_compaction,
                after_messages=conversation_for_model,
            )
            l4_applied_before_request = (
                runtime._compaction_pipeline.llm_summarization.last_cost_metrics or {}
            ).get("decision") == "summarize"
            if conversation_for_model is not conversation:
                conversation = conversation_for_model
            runtime._record_context_window_metrics()
            runtime._record_l4_decision_metric(
                runtime._compaction_pipeline.llm_summarization.last_cost_metrics
            )
            budget = runtime._estimate_window_budget(conversation_for_model)
            runtime_reminders = _apply_l4_recent_file_hints(
                tuple(
                    dict.fromkeys(
                        (
                            *runtime_reminders,
                            *runtime._build_l4_rehydration_reminders(
                                runtime._compaction_pipeline.llm_summarization.last_cost_metrics
                            ),
                        )
                    )
                ),
                runtime._compaction_pipeline.llm_summarization.last_cost_metrics,
            )
            context, turn_context = runtime._assemble_turn_context(
                user_message=user_message,
                conversation=conversation_for_model,
                plan_state=current_plan_state,
                runtime_reminders=runtime_reminders,
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
                tools=tools,
            )
            request_budget = runtime._estimate_request_window_budget(request_shape)
            request_needs_l4 = not l4_applied_before_request
            if request_needs_l4:
                conversation_before_request_compaction = conversation_for_model
                try:
                    conversation_for_model = runtime._compaction_pipeline.llm_summarization.apply(
                        conversation_for_model,
                        CacheZones.from_conversation(conversation_for_model),
                        request_budget,
                        snapshot=runtime._full_context_snapshot(request_shape),
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
                    )
            if request_needs_l4 and conversation_for_model is not conversation_before_request_compaction:
                runtime._record_compaction_metric(
                    before_messages=conversation_before_request_compaction,
                    after_messages=conversation_for_model,
                )
                runtime._record_l4_decision_metric(
                    runtime._compaction_pipeline.llm_summarization.last_cost_metrics
                )
                conversation = conversation_for_model
                runtime_reminders = _apply_l4_recent_file_hints(
                    tuple(
                        dict.fromkeys(
                            (
                                *runtime_reminders,
                                *runtime._build_l4_rehydration_reminders(
                                    runtime._compaction_pipeline.llm_summarization.last_cost_metrics
                                ),
                            )
                        )
                    ),
                    runtime._compaction_pipeline.llm_summarization.last_cost_metrics,
                )
                context, turn_context = runtime._assemble_turn_context(
                    user_message=user_message,
                    conversation=conversation_for_model,
                    plan_state=current_plan_state,
                    runtime_reminders=runtime_reminders,
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
                    tools=tools,
                )
                request_budget = runtime._estimate_request_window_budget(request_shape)
            budget = request_budget
            runtime_reminders = BudgetNudge().apply(budget, runtime_reminders)
            runtime_items = runtime._build_runtime_items(request_shape=request_shape)
            legacy_messages = runtime._build_messages(request_shape=request_shape)
            try:
                turn_result, turn_streamed_chunks = runtime._request_model_turn(
                    runtime_items=runtime_items,
                    legacy_messages=legacy_messages,
                    tools=tools,
                    stream_sink=stream_sink,
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
                if recovery_action.should_retry:
                    loop_state = recovery_action.next_state
                    carryover_runtime_reminders = recovery_action.runtime_reminders
                    if recovery_action.escalated_max_output_tokens is not None:
                        _set_max_output_tokens(
                            runtime._model_adapter,
                            recovery_action.escalated_max_output_tokens,
                        )
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
                        runtime._recovery_sleep(recovery_action.delay_seconds)
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
                                    or (exc.stop_reason.value if exc.stop_reason else "model_error"),
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
                            reactive_compacted = (
                                runtime._compaction_pipeline.llm_summarization.apply(
                                    conversation,
                                    CacheZones.from_conversation(conversation),
                                    reactive_budget,
                                    snapshot=runtime._full_context_snapshot(request_shape),
                                    force=True,
                                    source="reactive_error",
                                )
                            )
                            loop_state = LoopState(
                                context_window_retries=loop_state.context_window_retries,
                                transport_retries=loop_state.transport_retries,
                                output_token_retries=loop_state.output_token_retries,
                                context_recovery_stage="reactive_compact",
                                reactive_compact_attempted=True,
                            )
                            if reactive_compacted is not before_reactive:
                                conversation = reactive_compacted
                                runtime._record_compaction_metric(
                                    before_messages=before_reactive,
                                    after_messages=reactive_compacted,
                                )
                                runtime._record_l4_decision_metric(
                                    runtime._compaction_pipeline.llm_summarization.last_cost_metrics
                                )
                                carryover_runtime_reminders = tuple(
                                    dict.fromkeys(
                                        (
                                            *carryover_runtime_reminders,
                                            *runtime._build_l4_rehydration_reminders(
                                                runtime._compaction_pipeline.llm_summarization.last_cost_metrics
                                            ),
                                            *_apply_l4_recent_file_hints(
                                                (),
                                                runtime._compaction_pipeline.llm_summarization.last_cost_metrics,
                                            ),
                                        )
                                    )
                                )
                    continue
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
                )
            except Exception as exc:  # pragma: no cover - guarded by focused tests
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

            (
                current_plan_state,
                turn_has_tool_call,
                turn_text_chunks,
                early_response,
            ) = runtime._consume_assistant_blocks(
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
            )
            if early_response is not None:
                response, status, stop_reason = early_response
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
                runtime._record_ptl_metric(
                    triggered=checkpoint_result.continue_reason
                    in {
                        ContinueReason.FORCE_ANSWER,
                        ContinueReason.REROUTE,
                        ContinueReason.TRUNCATION_AWARE,
                    }
                )
                continue

            assistant_message = "".join(turn_text_chunks)
            if turn_result.done and assistant_message:
                current_plan_state = runtime._complete_task_if_active(
                    current_plan_state,
                    initial_in_progress_item_id,
                )
                runtime._save_runtime_state(
                    conversation=conversation,
                    plan_state=current_plan_state,
                )
                runtime._memory_service.append_session_summary(
                    runtime._config.session_id,
                    assistant_message,
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

    def _recovery_action_for_model_error(
        self,
        *,
        exc: ModelResponseError,
        loop_state: "LoopState",
        runtime_reminders: tuple[str, ...],
    ) -> "TurnRecoveryAction":
        failure_kind = exc.failure_kind or ""
        stop_reason = exc.stop_reason

        if stop_reason is StopReason.CONTEXT_WINDOW_EXCEEDED or failure_kind == "context_window_exceeded":
            if loop_state.context_window_retries == 0:
                warning_text = (
                    "Context window exceeded. Retrying after draining redundant context."
                )
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
                        output_token_retries=loop_state.output_token_retries,
                        context_recovery_stage="collapse_drain",
                        reactive_compact_attempted=loop_state.reactive_compact_attempted,
                    ),
                )
            if loop_state.context_window_retries == 1:
                warning_text = (
                    "Context window still exceeded. Retrying once after reactive compaction."
                )
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
                        output_token_retries=loop_state.output_token_retries,
                        context_recovery_stage="reactive_compact",
                        reactive_compact_attempted=False,
                    ),
                    invoke_pre_compact_hook=True,
                )
            if loop_state.context_window_retries >= 2:
                return TurnRecoveryAction(next_state=loop_state)

        if failure_kind in {"output_token_limit", "max_output_tokens", "output_tokens_exceeded"}:
            if loop_state.output_token_retries >= 3:
                return TurnRecoveryAction(next_state=loop_state)
            if loop_state.output_token_retries == 0:
                warning_text = (
                    "Model output hit the token limit. Retrying with an escalated output budget."
                )
                return TurnRecoveryAction(
                    should_retry=True,
                    warning_text=warning_text,
                    runtime_reminders=tuple(
                        dict.fromkeys(
                            (
                                *runtime_reminders,
                                "The previous response hit the output budget. Continue directly with a concise complete answer.",
                            )
                        )
                    ),
                    next_state=LoopState(
                        context_window_retries=loop_state.context_window_retries,
                        transport_retries=loop_state.transport_retries,
                        output_token_retries=1,
                        context_recovery_stage=loop_state.context_recovery_stage,
                        reactive_compact_attempted=loop_state.reactive_compact_attempted,
                    ),
                    escalated_max_output_tokens=65_536,
                )
            warning_text = (
                f"Model output hit the token limit again. Retrying recovery message ({loop_state.output_token_retries + 1}/3)."
            )
            return TurnRecoveryAction(
                should_retry=True,
                warning_text=warning_text,
                runtime_reminders=tuple(
                    dict.fromkeys(
                        (
                            *runtime_reminders,
                            "Continue directly from the current answer. Do not apologize. Finish the response in compact form.",
                        )
                    )
                ),
                next_state=LoopState(
                    context_window_retries=loop_state.context_window_retries,
                    transport_retries=loop_state.transport_retries,
                    output_token_retries=loop_state.output_token_retries + 1,
                    context_recovery_stage=loop_state.context_recovery_stage,
                    reactive_compact_attempted=loop_state.reactive_compact_attempted,
                ),
            )

        if is_transient_recovery_failure(
            failure_kind=failure_kind,
            is_retryable=exc.is_retryable or stop_reason is StopReason.TRANSPORT_FAILED,
        ):
            max_attempts = max(0, self._runtime._config.transport_retry_limit)
            if loop_state.transport_retries >= max_attempts:
                return TurnRecoveryAction(next_state=loop_state)
            attempt = loop_state.transport_retries + 1
            delay_seconds = RetryBackoffPolicy().delay_for_attempt(attempt)
            recovery_failure_kind = failure_kind or "transport_error"
            warning_text = (
                f"Temporary model transport failure. Retrying request ({attempt}/{max_attempts}) with the current turn state."
            )
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
                    output_token_retries=loop_state.output_token_retries,
                    context_recovery_stage=loop_state.context_recovery_stage,
                    reactive_compact_attempted=loop_state.reactive_compact_attempted,
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
    ) -> TurnResponse:
        runtime = self._runtime
        interrupt_warning = (
            "Turn interrupted. Runtime state was preserved; resume from the saved context if needed."
        )
        runtime._persist_model_continuation_state(
            turn_id=turn_id,
            phase="interrupted",
        )
        activity_events.append(
            ActivityEvent(kind="model_error", message=interrupt_warning)
        )
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.WARNING,
                text=interrupt_warning,
            ),
        )
        runtime._save_runtime_state(
            conversation=conversation,
            plan_state=current_plan_state,
        )
        runtime._session_service.save_suspended_turn(
            runtime._config.session_id,
            SuspendedTurn(
                user_message=user_message,
                conversation=tuple(conversation.messages),
                plan_state=current_plan_state,
            ),
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
            stop_reason=StopReason.MODEL_ERROR,
            turn_items=turn_items,
            context_baseline=latest_context_baseline,
        )


@dataclass(slots=True, frozen=True)
class LoopState:
    context_window_retries: int = 0
    transport_retries: int = 0
    output_token_retries: int = 0
    context_recovery_stage: str | None = None
    reactive_compact_attempted: bool = False


@dataclass(slots=True, frozen=True)
class TurnRecoveryAction:
    should_retry: bool = False
    warning_text: str = ""
    runtime_reminders: tuple[str, ...] = ()
    next_state: LoopState = LoopState()
    invoke_pre_compact_hook: bool = False
    escalated_max_output_tokens: int | None = None
    delay_seconds: float = 0.0
    metadata: dict[str, object] = field(default_factory=dict)


def _apply_l4_recent_file_hints(
    runtime_reminders: tuple[str, ...],
    cost_metrics: dict[str, int | float | str | list[str]] | None,
) -> tuple[str, ...]:
    if cost_metrics is None:
        return runtime_reminders
    raw_files = cost_metrics.get("recent_files")
    if not isinstance(raw_files, list):
        return runtime_reminders
    files = [path for path in raw_files if isinstance(path, str) and path]
    if not files:
        return runtime_reminders
    reminder = (
        "[Compaction applied. Recent files: "
        f"{', '.join(files)}. Re-read these files if you need current content.]"
    )
    if reminder in runtime_reminders:
        return runtime_reminders
    return (*runtime_reminders, reminder)


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
            warning = (
                f"Turn budget is above 60% ({budget.total_tokens}/{budget.max_tokens} tokens, about {budget.remaining} remaining). Prefer shorter reasoning and only essential tool calls."
            )
            if warning not in reminders:
                reminders.append(warning)

        if budget.usage_ratio >= self.force_answer_threshold:
            warning = (
                f"Turn budget is above 85% ({budget.total_tokens}/{budget.max_tokens} tokens, about {budget.remaining} remaining). If you have enough evidence, answer now and avoid more tool calls."
            )
            if warning not in reminders:
                reminders.append(warning)

        return tuple(reminders)


def _set_max_output_tokens(model_adapter: object, value: int) -> None:
    setter = getattr(model_adapter, "set_max_output_tokens", None)
    if callable(setter):
        setter(value)

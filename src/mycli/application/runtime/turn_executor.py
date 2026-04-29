from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import uuid4

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    ActivityEvent,
    ContextBaseline,
    DecisionAction,
    PlanState,
    SessionCommandAllowance,
    StopReason,
    TurnItem,
    TurnItemType,
    TurnResponse,
    TurnStatus,
)
from mycli.infrastructure.openai_client import ModelResponseError

if TYPE_CHECKING:
    from mycli.application.runtime.agent_runtime import AgentRuntime
    from mycli.domain.capabilities import CapabilityActivation


class TurnExecutor:
    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime

    def execute_user_turn(self, user_message: str) -> TurnResponse:
        runtime = self._runtime
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

        conversation = runtime._session_service.load_conversation(runtime._config.session_id)
        current_plan_state = runtime._session_service.load_plan_state(runtime._config.session_id)
        initial_in_progress_item_id = current_plan_state.current_in_progress_item_id()
        turn_id = f"turn_{uuid4().hex}"
        started_at = runtime._timestamp()
        turn_items: list[TurnItem] = []
        runtime._load_model_continuation_state(turn_id=turn_id)
        capability_activations = runtime._resolve_capability_activations(user_message)
        conversation.append(Message(role="user", content=user_message))
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(type=TurnItemType.USER_MESSAGE, text=user_message),
        )
        runtime._append_capability_turn_items(
            turn_id=turn_id,
            turn_items=turn_items,
            capability_activations=capability_activations,
        )
        return self._run_turn_loop(
            user_message=user_message,
            conversation=conversation,
            current_plan_state=current_plan_state,
            initial_in_progress_item_id=initial_in_progress_item_id,
            turn_id=turn_id,
            started_at=started_at,
            turn_items=turn_items,
            capability_activations=capability_activations,
            progress_updates=[],
            activity_events=[],
            streamed_chunks=[],
        )

    def resolve_pending_approval(self, choice: str) -> TurnResponse:
        runtime = self._runtime
        decision = runtime._session_service.load_pending_decision(runtime._config.session_id)
        if decision is None:
            return TurnResponse(assistant_message="There is no pending decision to resolve.")
        suspended = runtime._session_service.load_suspended_turn(runtime._config.session_id)
        if suspended is None:
            suspended = runtime._session_service.reconstruct_suspended_turn(
                runtime._config.session_id,
                decision,
            )
        if suspended is None or suspended.pending_approval is None:
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
        current_plan_state = runtime._session_service.load_plan_state(runtime._config.session_id)
        turn_id = f"turn_{uuid4().hex}"
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
            return runtime._finalize_response(
                response=TurnResponse(
                    assistant_message=message,
                    progress_updates=("[decision] rejected",),
                ),
                turn_id=turn_id,
                user_message=suspended.user_message,
                started_at=started_at,
                status=TurnStatus.COMPLETED,
                stop_reason=StopReason.ASSISTANT_COMPLETED,
                turn_items=turn_items,
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
        capability_activations = runtime._resolve_capability_activations(
            suspended.user_message
        )
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(type=TurnItemType.USER_MESSAGE, text=suspended.user_message),
        )
        runtime._append_capability_turn_items(
            turn_id=turn_id,
            turn_items=turn_items,
            capability_activations=capability_activations,
        )
        progress_updates = ["[decision] approved"]
        activity_events: list[ActivityEvent] = []
        streamed_chunks: list[str] = []
        initial_planned_exposure = runtime._plan_tool_exposure(
            user_message=suspended.user_message,
            conversation=conversation,
            plan_state=current_plan_state,
            capability_activations=capability_activations,
        )
        if initial_planned_exposure.lifecycle_events:
            runtime._append_dynamic_tool_lifecycle_events(
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
            capability_activations=capability_activations,
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
        capability_activations: tuple[CapabilityActivation, ...],
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        streamed_chunks: list[str],
        last_tool_exposure_summary: dict[str, list[str]] | None = None,
    ) -> TurnResponse:
        runtime = self._runtime
        last_runtime_policy_state: dict[str, object] | None = None
        latest_context_baseline: ContextBaseline | None = None
        hard_turn_limit = runtime._runtime_policy.hard_step_limit(
            user_message=user_message,
            configured_max_steps=runtime._config.max_steps,
        )

        for step_index in range(hard_turn_limit):
            (
                _soft_budget,
                reasoning_effort,
                runtime_reminders,
                runtime_policy_state,
                force_answer,
                stage_message,
                policy_response,
            ) = runtime._policy_decision(
                user_message=user_message,
                conversation=conversation,
                plan_state=current_plan_state,
                step_index=step_index,
            )
            if policy_response is not None:
                runtime._append_turn_item(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    item=TurnItem(
                        type=TurnItemType.WARNING,
                        text=policy_response.assistant_message,
                    ),
                )
                runtime._save_runtime_state(
                    conversation=conversation,
                    plan_state=current_plan_state,
                )
                return runtime._finalize_response(
                    response=policy_response,
                    turn_id=turn_id,
                    user_message=user_message,
                    started_at=started_at,
                    status=TurnStatus.COMPLETED,
                    stop_reason=StopReason.LOOP_DETECTED,
                    turn_items=turn_items,
                    context_baseline=latest_context_baseline,
                )

            activity_events.append(
                ActivityEvent(
                    kind="thinking",
                    message="Thinking: deciding next action",
                )
            )
            if runtime_policy_state != last_runtime_policy_state:
                runtime._append_runtime_policy_activity(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    activity_events=activity_events,
                    policy_state=runtime_policy_state,
                )
                last_runtime_policy_state = dict(runtime_policy_state)
            runtime._append_structured_repo_activity(
                turn_id=turn_id,
                turn_items=turn_items,
                activity_events=activity_events,
                stage_message=stage_message,
            )
            runtime._set_model_log_context(turn_id)
            runtime._set_model_runtime_event_recorder(turn_id)
            runtime._set_model_reasoning_effort(reasoning_effort)
            planned_exposure = runtime._plan_tool_exposure(
                user_message=user_message,
                conversation=conversation,
                plan_state=current_plan_state,
                capability_activations=capability_activations,
            )
            if planned_exposure.lifecycle_events:
                runtime._append_dynamic_tool_lifecycle_events(
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
            context, turn_context = runtime._assemble_turn_context(
                user_message=user_message,
                conversation=conversation,
                plan_state=current_plan_state,
                runtime_reminders=runtime_reminders,
                runtime_policy_state=runtime_policy_state,
                capability_activations=capability_activations,
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
                allow_tools=not force_answer,
            )
            request_shape = runtime._build_and_trace_request_shape(
                turn_id=turn_id,
                contract=contract,
                tools=tools,
            )
            runtime_items = runtime._build_runtime_items(request_shape=request_shape)
            legacy_messages = runtime._build_messages(request_shape=request_shape)
            try:
                turn_result, turn_streamed_chunks = runtime._request_model_turn(
                    runtime_items=runtime_items,
                    legacy_messages=legacy_messages,
                    tools=tools,
                )
                streamed_chunks.extend(turn_streamed_chunks)
                runtime._persist_model_continuation_state(
                    turn_id=turn_id,
                    phase="model_turn_completed",
                )
            except ModelResponseError as exc:
                return self._finalize_model_error(
                    user_message=user_message,
                    conversation=conversation,
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
            except Exception as exc:  # pragma: no cover - guarded by focused tests
                return self._finalize_runtime_exception(
                    user_message=user_message,
                    conversation=conversation,
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
                tool_exposure=planned_exposure.exposure,
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

        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.WARNING,
                text="I hit the step limit before reaching a confident answer.",
            ),
        )
        runtime._save_runtime_state(
            conversation=conversation,
            plan_state=current_plan_state,
        )
        return runtime._finalize_response(
            response=TurnResponse(
                assistant_message="I hit the step limit before reaching a confident answer.",
                activity_events=tuple(activity_events),
                progress_updates=tuple(progress_updates),
            ),
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=TurnStatus.COMPLETED,
            stop_reason=StopReason.MAX_STEPS_REACHED,
            turn_items=turn_items,
            context_baseline=latest_context_baseline,
        )

    def _finalize_model_error(
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
        progress_updates: list[str],
        exc: ModelResponseError,
        phase: str,
        stop_reason: StopReason,
        assistant_message: str,
    ) -> TurnResponse:
        runtime = self._runtime
        runtime._persist_model_continuation_state(turn_id=turn_id, phase=phase)
        activity_events.append(
            ActivityEvent(kind="model_error", message=f"Model error: {exc}")
        )
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.WARNING,
                text=f"Model error: {exc}",
            ),
        )
        error_path = exc.error_path or runtime._log_runtime_exception(
            turn_id=turn_id,
            phase="model_request_failed",
            exc=exc,
        )
        return runtime._finalize_response(
            response=TurnResponse(
                assistant_message=assistant_message,
                activity_events=tuple(activity_events),
                error_details=runtime._error_details(error_path),
                progress_updates=tuple(progress_updates),
                plan_steps=runtime._planning_service.render_steps(current_plan_state),
            ),
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=TurnStatus.FAILED,
            stop_reason=stop_reason,
            turn_items=turn_items,
            context_baseline=latest_context_baseline,
        )

    def _finalize_runtime_exception(
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
        progress_updates: list[str],
        exc: Exception,
    ) -> TurnResponse:
        runtime = self._runtime
        runtime._persist_model_continuation_state(
            turn_id=turn_id,
            phase="runtime_error",
        )
        activity_events.append(
            ActivityEvent(kind="model_error", message=f"Runtime error: {exc}")
        )
        runtime._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.WARNING,
                text=f"Runtime error: {exc}",
            ),
        )
        error_path = runtime._log_runtime_exception(
            turn_id=turn_id,
            phase="runtime_error",
            exc=exc,
        )
        return runtime._finalize_response(
            response=TurnResponse(
                assistant_message=f"Internal runtime error: {exc}",
                activity_events=tuple(activity_events),
                error_details=runtime._error_details(error_path),
                progress_updates=tuple(progress_updates),
                plan_steps=runtime._planning_service.render_steps(current_plan_state),
            ),
            turn_id=turn_id,
            user_message=user_message,
            started_at=started_at,
            status=TurnStatus.FAILED,
            stop_reason=StopReason.RUNTIME_ERROR,
            turn_items=turn_items,
            context_baseline=latest_context_baseline,
        )

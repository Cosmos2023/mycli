from __future__ import annotations

from typing import Callable

from mycli.domain.conversation import Conversation
from mycli.domain.logging import LogLevel
from mycli.domain.runtime import (
    ActivityEvent,
    DecisionKind,
    ModelTurnResult,
    PendingDecision,
    PendingClarification,
    PlanState,
    RuntimeBlock,
    RuntimeStreamEvent,
    RuntimeTraceEvent,
    StopReason,
    SuspendedTurn,
    ToolRuntimeDecision,
    ToolRuntimeDecisionKind,
    TurnItem,
    TurnItemType,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.tooling.exposure import ToolExposure, ToolRouteSource
from mycli.domain.tooling.calls import ToolCall
from mycli.application.runtime.tools.tool_execution_service import CONCURRENCY_SAFE_TOOLS
from mycli.services.approval.approval_service import ApprovalService
from mycli.services.tracing import TraceService
from mycli.state.session_service import SessionService
from mycli.tools.routing.tool_router import ToolRouter
from mycli.utils.workspace_logger import WorkspaceLogService


class AssistantBlockConsumer:
    """Consumes assistant model blocks into transcript entries and runtime events."""

    def __init__(
        self,
        *,
        session_id: str,
        session_service: SessionService,
        approval_service: ApprovalService,
        trace_service: TraceService,
        workspace_log_service: WorkspaceLogService,
        append_turn_item: Callable[..., None],
        tool_call_from_block: Callable[[RuntimeBlock], ToolCall],
        record_assistant_text_block: Callable[..., None],
        record_assistant_tool_calls: Callable[..., None],
        execute_tool_call: Callable[..., PlanState],
        execute_tool_call_for_clarification: Callable[..., tuple[PlanState, PendingClarification | None]],
        execute_tool_calls: Callable[..., PlanState],
        pending_decision_from_approval: Callable[..., PendingDecision],
        runtime_policy_decision: Callable[..., ToolRuntimeDecision | None] | None = None,
    ) -> None:
        self._session_id = session_id
        self._session_service = session_service
        self._approval_service = approval_service
        self._trace_service = trace_service
        self._workspace_log_service = workspace_log_service
        self._append_turn_item = append_turn_item
        self._tool_call_from_block = tool_call_from_block
        self._record_assistant_text_block = record_assistant_text_block
        self._record_assistant_tool_calls = record_assistant_tool_calls
        self._execute_tool_call = execute_tool_call
        self._execute_tool_call_for_clarification = execute_tool_call_for_clarification
        self._execute_tool_calls = execute_tool_calls
        self._pending_decision_from_approval = pending_decision_from_approval
        self._runtime_policy_decision = runtime_policy_decision

    def set_session_id(self, session_id: str) -> None:
        self._session_id = session_id

    def consume_assistant_blocks(
        self,
        *,
        turn_result: ModelTurnResult,
        conversation: Conversation,
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        user_message: str,
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        streamed_chunks: list[str],
        turn_items: list[TurnItem],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None = None,
    ) -> tuple[
        PlanState,
        bool,
        list[str],
        tuple[TurnResponse, TurnStatus, StopReason] | None,
    ]:
        current_plan_state = plan_state
        turn_has_tool_call = False
        turn_text_chunks: list[str] = []
        for item in turn_result.items:
            if item.role != "assistant":
                continue
            pending_text_chunks: list[str] = []
            pending_text_block: RuntimeBlock | None = None
            tool_call_blocks = tuple(
                block for block in item.blocks if block.type == "tool_call"
            )
            tool_call_group_recorded = False
            pending_safe_tool_calls: list[tuple[ToolCall, RuntimeBlock]] = []

            def flush_pending_text(*, record_conversation: bool = True) -> None:
                nonlocal pending_text_chunks, pending_text_block
                if not pending_text_chunks or pending_text_block is None:
                    pending_text_chunks = []
                    pending_text_block = None
                    return
                combined_text = "".join(pending_text_chunks)
                combined_block = RuntimeBlock(
                    type="text",
                    text=combined_text,
                    provider_id=pending_text_block.provider_id,
                    metadata=dict(pending_text_block.metadata),
                )
                if record_conversation:
                    self._record_assistant_text_block(
                        conversation,
                        block=combined_block,
                        response_id=turn_result.response_id,
                    )
                turn_text_chunks.append(combined_text)
                self._append_turn_item(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    item=TurnItem(
                        type=TurnItemType.ASSISTANT_MESSAGE,
                        text=combined_text,
                        metadata={"provider_id": combined_block.provider_id, **combined_block.metadata},
                    ),
                )
                pending_text_chunks = []
                pending_text_block = None

            def record_tool_call_group_once() -> None:
                nonlocal tool_call_group_recorded
                if tool_call_group_recorded or not tool_call_blocks:
                    return
                self._record_assistant_tool_calls(
                    conversation,
                    tool_calls=tuple(
                        self._tool_call_from_block(tool_block)
                        for tool_block in tool_call_blocks
                    ),
                    blocks=tuple(
                        replay_block
                        for replay_block in item.blocks
                        if replay_block.type in {"text", "tool_call"}
                    ),
                    response_id=turn_result.response_id,
                )
                tool_call_group_recorded = True

            def flush_pending_safe_tool_calls() -> None:
                nonlocal current_plan_state
                if not pending_safe_tool_calls:
                    return
                record_tool_call_group_once()
                calls = tuple(call for call, _block in pending_safe_tool_calls)
                metadata: dict[str, object] | None = None
                provider_id: str | None = None
                if pending_safe_tool_calls:
                    first_block = pending_safe_tool_calls[0][1]
                    metadata = dict(first_block.metadata)
                    provider_id = first_block.provider_id
                current_plan_state = self._execute_tool_calls(
                    conversation=conversation,
                    calls=calls,
                    tool_router=tool_router,
                    tool_exposure=tool_exposure,
                    plan_state=current_plan_state,
                    turn_id=turn_id,
                    activity_events=activity_events,
                    turn_items=turn_items,
                    provider_id=provider_id,
                    response_id=turn_result.response_id,
                    metadata=metadata,
                    record_assistant_call=False,
                    lifecycle_sink=stream_sink,
                )
                pending_safe_tool_calls.clear()

            for block in item.blocks:
                if block.type == "reasoning":
                    flush_pending_safe_tool_calls()
                    flush_pending_text(record_conversation=not tool_call_blocks)
                    if block.text:
                        progress_updates.append(block.text)
                        activity_kind = "planning" if "plan" in block.text.lower() else "thinking"
                        activity_events.append(
                            ActivityEvent(
                                kind=activity_kind,
                                message=block.text,
                            )
                        )
                        self._append_turn_item(
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
                    continue

                if block.type == "text":
                    flush_pending_safe_tool_calls()
                    if block.text:
                        pending_text_chunks.append(block.text)
                        pending_text_block = block
                    continue

                if block.type != "tool_call":
                    continue

                flush_pending_text(record_conversation=not tool_call_blocks)
                turn_has_tool_call = True
                tool_call = self._tool_call_from_block(block)
                self._emit_visible_provider_reasoning(
                    block=block,
                    turn_id=turn_id,
                    progress_updates=progress_updates,
                    activity_events=activity_events,
                    turn_items=turn_items,
                )
                if tool_call.name not in tool_exposure.callable_tool_names():
                    flush_pending_safe_tool_calls()
                    rendered_names = ", ".join(tool_exposure.callable_tool_names()) or "none"
                    warning_message = (
                        f"The model requested unsupported tool '{tool_call.name}' that is not exposed for this turn. "
                        f"Callable tools: {rendered_names}."
                    )
                    self._append_turn_item(
                        turn_id=turn_id,
                        turn_items=turn_items,
                        item=TurnItem(
                            type=TurnItemType.WARNING,
                            text=warning_message,
                            tool_name=tool_call.name,
                            call_id=tool_call.call_id,
                        ),
                    )
                    return (
                        current_plan_state,
                        turn_has_tool_call,
                        turn_text_chunks,
                        (
                            TurnResponse(
                                assistant_message=warning_message,
                                streamed_chunks=tuple(streamed_chunks),
                                progress_updates=tuple(progress_updates),
                            ),
                            TurnStatus.FAILED,
                            StopReason.MODEL_ERROR,
                        ),
                    )

                runtime_decision: ToolRuntimeDecision | None = None
                if (
                    self._runtime_policy_decision is not None
                    and tool_call.name not in CONCURRENCY_SAFE_TOOLS
                ):
                    runtime_decision = self._runtime_policy_decision(
                        call=tool_call,
                        tool_exposure=tool_exposure,
                        turn_id=turn_id,
                    )
                    if runtime_decision is not None:
                        pending_response = self._pending_response_from_runtime_decision(
                            runtime_decision=runtime_decision,
                            conversation=conversation,
                            current_plan_state=current_plan_state,
                            user_message=user_message,
                            turn_id=turn_id,
                            turn_items=turn_items,
                            turn_has_tool_call=turn_has_tool_call,
                            turn_text_chunks=turn_text_chunks,
                            streamed_chunks=streamed_chunks,
                            progress_updates=progress_updates,
                            activity_events=activity_events,
                            flush_pending_safe_tool_calls=flush_pending_safe_tool_calls,
                            record_tool_call_group_once=record_tool_call_group_once,
                        )
                        if pending_response is not None:
                            return pending_response

                safety = self._approval_service._safety_policy.evaluate(tool_call)
                if (
                    runtime_decision is None
                    and safety.kind is not DecisionKind.DENY
                    and self._session_service.is_command_allowed(
                        self._session_id,
                        safety.command_pattern,
                    )
                ):
                    self._record_approval_auto_allowed(
                        turn_id=turn_id,
                        tool_call=tool_call,
                        command_pattern=safety.command_pattern,
                        reason=safety.reason,
                        safety_metadata=safety.metadata,
                    )
                    if tool_call.name in CONCURRENCY_SAFE_TOOLS:
                        pending_safe_tool_calls.append((tool_call, block))
                        continue
                    flush_pending_safe_tool_calls()
                    record_tool_call_group_once()
                    current_plan_state = self._execute_tool_call(
                        conversation=conversation,
                        call=tool_call,
                        tool_router=tool_router,
                        tool_exposure=tool_exposure,
                        plan_state=current_plan_state,
                        turn_id=turn_id,
                        activity_events=activity_events,
                        turn_items=turn_items,
                        provider_id=block.provider_id,
                        response_id=turn_result.response_id,
                        metadata=dict(block.metadata),
                        record_assistant_call=False,
                        lifecycle_sink=stream_sink,
                        policy_approved=True,
                    )
                    continue

                if self._is_auto_allowed_contributed_tool(tool_call, tool_exposure):
                    if tool_call.name in CONCURRENCY_SAFE_TOOLS:
                        pending_safe_tool_calls.append((tool_call, block))
                        continue
                    flush_pending_safe_tool_calls()
                    record_tool_call_group_once()
                    current_plan_state = self._execute_tool_call(
                        conversation=conversation,
                        call=tool_call,
                        tool_router=tool_router,
                        tool_exposure=tool_exposure,
                        plan_state=current_plan_state,
                        turn_id=turn_id,
                        activity_events=activity_events,
                        turn_items=turn_items,
                        provider_id=block.provider_id,
                        response_id=turn_result.response_id,
                        metadata=dict(block.metadata),
                        record_assistant_call=False,
                        lifecycle_sink=stream_sink,
                    )
                    continue

                if tool_call.name == "AskUserQuestion":
                    flush_pending_safe_tool_calls()
                    record_tool_call_group_once()
                    current_plan_state, pending_clarification = (
                        self._execute_tool_call_for_clarification(
                            conversation=conversation,
                            call=tool_call,
                            tool_router=tool_router,
                            tool_exposure=tool_exposure,
                            plan_state=current_plan_state,
                            turn_id=turn_id,
                            activity_events=activity_events,
                            turn_items=turn_items,
                            provider_id=block.provider_id,
                            response_id=turn_result.response_id,
                            metadata=dict(block.metadata),
                            lifecycle_sink=stream_sink,
                        )
                    )
                    if pending_clarification is not None:
                        self._session_service.save_suspended_turn(
                            self._session_id,
                            SuspendedTurn(
                                user_message=user_message,
                                conversation=tuple(conversation.messages),
                                plan_state=current_plan_state,
                                pending_clarification=pending_clarification,
                                suspend_reason=StopReason.CLARIFICATION_REQUIRED,
                            ),
                        )
                        question = getattr(pending_clarification, "question")
                        waiting_message = f"Waiting clarification: {question}"
                        return (
                            current_plan_state,
                            turn_has_tool_call,
                            turn_text_chunks,
                            (
                                TurnResponse(
                                    assistant_message="A clarification is waiting for your response.",
                                    activity_events=(
                                        *activity_events,
                                        ActivityEvent(
                                            kind="waiting_clarification",
                                            message=waiting_message,
                                            tool_name=tool_call.name,
                                            preview=question,
                                        ),
                                    ),
                                    streamed_chunks=tuple(streamed_chunks),
                                    progress_updates=tuple(progress_updates),
                                ),
                                TurnStatus.WAITING_CLARIFICATION,
                                StopReason.CLARIFICATION_REQUIRED,
                            ),
                    )
                    continue

                policy_approved = runtime_decision is not None

                if not policy_approved:
                    approval = self._approval_service.evaluate(tool_call)
                    if approval.denied_reason is not None:
                        flush_pending_safe_tool_calls()
                        warning_message = f"Denied: {approval.denied_reason}"
                        self._append_turn_item(
                            turn_id=turn_id,
                            turn_items=turn_items,
                            item=TurnItem(
                                type=TurnItemType.WARNING,
                                text=warning_message,
                                tool_name=tool_call.name,
                                call_id=tool_call.call_id,
                            ),
                        )
                        return (
                            current_plan_state,
                            turn_has_tool_call,
                            turn_text_chunks,
                            (
                                TurnResponse(
                                    assistant_message=warning_message,
                                    streamed_chunks=tuple(streamed_chunks),
                                    progress_updates=tuple(progress_updates),
                                ),
                                TurnStatus.COMPLETED,
                                StopReason.ASSISTANT_COMPLETED,
                            ),
                        )

                    if approval.pending_approval is not None:
                        flush_pending_safe_tool_calls()
                        record_tool_call_group_once()
                        pending_decision = self._pending_decision_from_approval(
                            approval.pending_approval
                        )
                        self._session_service.save_pending_decision(
                            self._session_id,
                            pending_decision,
                        )
                        self._session_service.save_suspended_turn(
                            self._session_id,
                            SuspendedTurn(
                                user_message=user_message,
                                conversation=tuple(conversation.messages),
                                plan_state=current_plan_state,
                                pending_approval=approval.pending_approval,
                            ),
                        )
                        waiting_message = f"Waiting approval: {pending_decision.preview}"
                        self._append_turn_item(
                            turn_id=turn_id,
                            turn_items=turn_items,
                            item=TurnItem(
                                type=TurnItemType.APPROVAL_REQUEST,
                                text=waiting_message,
                                tool_name=pending_decision.tool_call.name,
                                call_id=pending_decision.tool_call.call_id,
                                metadata={"preview": pending_decision.preview},
                            ),
                        )
                        return (
                            current_plan_state,
                            turn_has_tool_call,
                            turn_text_chunks,
                            (
                                TurnResponse(
                                    assistant_message=(
                                        "A risky action is waiting for your decision. "
                                        "Choose 1 to approve once, 2 to reject, or 3 to allow for this session."
                                    ),
                                    activity_events=(
                                        *activity_events,
                                        ActivityEvent(
                                            kind="waiting_approval",
                                            message=waiting_message,
                                            tool_name=pending_decision.tool_call.name,
                                            preview=pending_decision.preview,
                                        ),
                                    ),
                                    streamed_chunks=tuple(streamed_chunks),
                                    progress_updates=tuple(progress_updates),
                                    pending_decision=pending_decision,
                                ),
                                TurnStatus.WAITING_APPROVAL,
                                StopReason.APPROVAL_REQUIRED,
                            ),
                        )

                    policy_approved = approval.auto_approved_by == "session_allowance"
                    if policy_approved:
                        self._record_approval_auto_allowed(
                            turn_id=turn_id,
                            tool_call=tool_call,
                            command_pattern=approval.command_pattern,
                            reason=approval.reason,
                            safety_metadata=approval.safety_metadata,
                        )

                if tool_call.name in CONCURRENCY_SAFE_TOOLS:
                    pending_safe_tool_calls.append((tool_call, block))
                    continue
                flush_pending_safe_tool_calls()
                record_tool_call_group_once()
                current_plan_state = self._execute_tool_call(
                    conversation=conversation,
                    call=tool_call,
                    tool_router=tool_router,
                    tool_exposure=tool_exposure,
                    plan_state=current_plan_state,
                    turn_id=turn_id,
                    activity_events=activity_events,
                    turn_items=turn_items,
                    provider_id=block.provider_id,
                    response_id=turn_result.response_id,
                    metadata=dict(block.metadata),
                    record_assistant_call=False,
                    lifecycle_sink=stream_sink,
                    policy_approved=policy_approved,
                )

            flush_pending_safe_tool_calls()
            flush_pending_text(record_conversation=not tool_call_blocks)

        return (
            current_plan_state,
            turn_has_tool_call,
            turn_text_chunks,
            None,
        )

    def _pending_response_from_runtime_decision(
        self,
        *,
        runtime_decision: ToolRuntimeDecision,
        conversation: Conversation,
        current_plan_state: PlanState,
        user_message: str,
        turn_id: str,
        turn_items: list[TurnItem],
        turn_has_tool_call: bool,
        turn_text_chunks: list[str],
        streamed_chunks: list[str],
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        flush_pending_safe_tool_calls: Callable[[], None],
        record_tool_call_group_once: Callable[[], None],
    ) -> tuple[
        PlanState,
        bool,
        list[str],
        tuple[TurnResponse, TurnStatus, StopReason],
    ] | None:
        if runtime_decision.kind is ToolRuntimeDecisionKind.DENIED:
            flush_pending_safe_tool_calls()
            warning_message = "Denied: Tool denied by runtime policy."
            self._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.WARNING,
                    text=warning_message,
                    tool_name=runtime_decision.tool_call.name,
                    call_id=runtime_decision.tool_call.call_id,
                ),
            )
            return (
                current_plan_state,
                turn_has_tool_call,
                turn_text_chunks,
                (
                    TurnResponse(
                        assistant_message=warning_message,
                        streamed_chunks=tuple(streamed_chunks),
                        progress_updates=tuple(progress_updates),
                    ),
                    TurnStatus.COMPLETED,
                    StopReason.ASSISTANT_COMPLETED,
                ),
            )
        if (
            runtime_decision.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL
            and runtime_decision.pending_approval is not None
        ):
            flush_pending_safe_tool_calls()
            record_tool_call_group_once()
            pending_decision = self._pending_decision_from_approval(
                runtime_decision.pending_approval
            )
            self._session_service.save_pending_decision(
                self._session_id,
                pending_decision,
            )
            self._session_service.save_suspended_turn(
                self._session_id,
                SuspendedTurn(
                    user_message=user_message,
                    conversation=tuple(conversation.messages),
                    plan_state=current_plan_state,
                    pending_approval=runtime_decision.pending_approval,
                ),
            )
            waiting_message = f"Waiting approval: {pending_decision.preview}"
            self._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=TurnItem(
                    type=TurnItemType.APPROVAL_REQUEST,
                    text=waiting_message,
                    tool_name=pending_decision.tool_call.name,
                    call_id=pending_decision.tool_call.call_id,
                    metadata={"preview": pending_decision.preview},
                ),
            )
            return (
                current_plan_state,
                turn_has_tool_call,
                turn_text_chunks,
                (
                    TurnResponse(
                        assistant_message=(
                            "A risky action is waiting for your decision. "
                            "Choose 1 to approve once or 2 to reject."
                        ),
                        activity_events=(
                            *activity_events,
                            ActivityEvent(
                                kind="waiting_approval",
                                message=waiting_message,
                                tool_name=pending_decision.tool_call.name,
                                preview=pending_decision.preview,
                            ),
                        ),
                        streamed_chunks=tuple(streamed_chunks),
                        progress_updates=tuple(progress_updates),
                        pending_decision=pending_decision,
                    ),
                    TurnStatus.WAITING_APPROVAL,
                    StopReason.APPROVAL_REQUIRED,
                ),
            )
        return None

    def _is_auto_allowed_contributed_tool(
        self,
        tool_call: ToolCall,
        tool_exposure: ToolExposure,
    ) -> bool:
        for entry in tool_exposure.entries:
            if entry.name != tool_call.name:
                continue
            return entry.source in {
                ToolRouteSource.RUNTIME,
                ToolRouteSource.PROVIDER,
            }
        return False

    def _emit_visible_provider_reasoning(
        self,
        *,
        block: RuntimeBlock,
        turn_id: str,
        progress_updates: list[str],
        activity_events: list[ActivityEvent],
        turn_items: list[TurnItem],
    ) -> None:
        reasoning_content = self._deepseek_reasoning_content_from_block(block)
        if reasoning_content is None:
            return
        metadata = {
            "provider_id": block.provider_id,
            "provider": "deepseek",
            "source": "provider_reasoning_content",
            "activity_kind": "thinking",
            "deepseek": {"reasoning_content": reasoning_content},
        }
        progress_updates.append(reasoning_content)
        activity_events.append(ActivityEvent(kind="thinking", message=reasoning_content))
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.REASONING,
                text=reasoning_content,
                metadata=metadata,
            ),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event="provider_reasoning_content",
            message="Exposed provider reasoning content",
            context={
                "session_id": self._session_id,
                "turn_id": turn_id,
                **metadata,
            },
        )

    def _record_approval_auto_allowed(
        self,
        *,
        turn_id: str,
        tool_call: ToolCall,
        command_pattern: str | None,
        reason: str | None,
        safety_metadata: dict[str, object] | None = None,
    ) -> None:
        payload: dict[str, object] = {
            "source": "session_allowance",
            "tool_name": tool_call.name,
            "call_id": tool_call.call_id,
            "command_pattern": command_pattern,
            "decision_id": tool_call.call_id or "decision_current",
            "reason": reason,
        }
        if safety_metadata:
            payload["safety_metadata"] = safety_metadata
        self._trace_service.append(
            self._session_id,
            RuntimeTraceEvent(kind="approval_auto_allowed", turn_id=turn_id, payload=payload),
        )
        self._workspace_log_service.log(
            level=LogLevel.INFO,
            event="approval_auto_allowed",
            message=f"Auto-approved {tool_call.name} via session allowance.",
            context=payload,
        )

    def _deepseek_reasoning_content_from_block(
        self,
        block: RuntimeBlock,
    ) -> str | None:
        deepseek_metadata = block.metadata.get("deepseek")
        if not isinstance(deepseek_metadata, dict):
            return None
        if deepseek_metadata.get("reasoning_content_missing") is True:
            return None
        reasoning_content = deepseek_metadata.get("reasoning_content")
        if not isinstance(reasoning_content, str):
            return None
        if not reasoning_content.strip():
            return None
        return reasoning_content

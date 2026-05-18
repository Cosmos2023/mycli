from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import ActivityEvent, PlanState, RuntimeBlock, RuntimeTraceEvent, TurnItem, TurnItemType
from mycli.domain.tooling.calls import ToolEvidence
from mycli.domain.tooling.exposure import ToolExposure
from mycli.domain.tooling.calls import ToolCall
from mycli.schemas.responses_protocol import ResponsesFunctionCallOutputPayload
from mycli.services.context.context_manager import ContextManager
from mycli.services.file_history import FileHistoryService
from mycli.services.hooks import HookAction, HookContext, HookManager, HookPoint
from mycli.services.security import InjectionGuard
from mycli.tools.routing.tool_router import ToolRouter
from mycli.services.tracing import TraceService
from mycli.tools.base import ToolResult

CONCURRENCY_SAFE_TOOLS = frozenset(
    {
        "Read",
        "Grep",
        "Glob",
        "LS",
        "WebSearch",
        "WebFetch",
        "Lint",
    }
)

FILE_MUTATION_TOOLS = frozenset(
    {
        "Edit",
        "Write",
        "edit_file",
        "write_file",
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
    ) -> None:
        self._session_id = session_id
        self._context_manager = context_manager
        self._trace_service = trace_service
        self._append_turn_item = append_turn_item
        self._append_lifecycle_events = append_lifecycle_events
        self._apply_tool_effects = apply_tool_effects
        self._normalize_tool_call = normalize_tool_call
        self._hook_manager = hook_manager or HookManager()
        self._file_history = file_history
        self._injection_guard = injection_guard or InjectionGuard()

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
    ) -> PlanState:
        current_plan_state = plan_state
        pending_safe_calls: list[ToolCall] = []

        def flush_safe_calls() -> None:
            nonlocal current_plan_state
            if not pending_safe_calls:
                return
            outcomes = self._execute_parallel_batch(
                calls=tuple(pending_safe_calls),
                tool_router=tool_router,
                tool_exposure=tool_exposure,
                plan_state=current_plan_state,
                turn_id=turn_id,
                provider_id=provider_id,
                response_id=response_id,
                metadata=metadata,
                record_assistant_call=record_assistant_call,
            )
            pending_safe_calls.clear()
            for outcome in outcomes:
                current_plan_state = outcome.plan_state
                conversation.messages.extend(outcome.messages)
                activity_events.extend(outcome.activity_events)
                turn_items.extend(outcome.turn_items)

        for call in calls:
            if call.name in CONCURRENCY_SAFE_TOOLS:
                pending_safe_calls.append(call)
                continue
            flush_safe_calls()
            current_plan_state = self.execute_tool_call(
                conversation=conversation,
                call=call,
                tool_router=tool_router,
                tool_exposure=tool_exposure,
                plan_state=current_plan_state,
                turn_id=turn_id,
                activity_events=activity_events,
                turn_items=turn_items,
                provider_id=provider_id,
                response_id=response_id,
                metadata=metadata,
                record_assistant_call=record_assistant_call,
            )
        flush_safe_calls()
        return current_plan_state

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
    ) -> PlanState:
        normalized_call = self._normalize_tool_call(call)
        hook_results = self._hook_manager.execute(
            HookPoint.PRE_TOOL_USE,
            HookContext(
                hook_point=HookPoint.PRE_TOOL_USE,
                tool_name=normalized_call.name,
                tool_args=dict(normalized_call.arguments),
                session_id=self._session_id,
            ),
        )
        for hook_result in hook_results:
            if hook_result.action is HookAction.DENY:
                denied_result = ToolResult(
                    success=False,
                    summary=f"Tool denied: {hook_result.message or normalized_call.name}",
                    error=hook_result.message or "tool denied by hook",
                    raw_payload={
                        "tool_name": normalized_call.name,
                        "arguments": dict(normalized_call.arguments),
                        "error_kind": "tool_denied_by_hook",
                    },
                )
                return self._record_tool_outcome(
                    conversation=conversation,
                    normalized_call=normalized_call,
                    result=denied_result,
                    plan_state=plan_state,
                    turn_id=turn_id,
                    activity_events=activity_events,
                    turn_items=turn_items,
                    metadata=metadata,
                    provider_id=provider_id,
                    response_id=response_id,
                    record_assistant_call=record_assistant_call,
                )
            if hook_result.action is HookAction.MODIFY and hook_result.modified_args:
                normalized_call = ToolCall(
                    name=normalized_call.name,
                    arguments={**normalized_call.arguments, **hook_result.modified_args},
                    reason=normalized_call.reason,
                    call_id=normalized_call.call_id,
                )
        turn_metadata = dict(metadata or {})
        turn_metadata["arguments"] = normalized_call.arguments
        turn_metadata["provider_id"] = provider_id
        start_event = self._tool_activity_event(normalized_call, phase="start")
        activity_events.append(start_event)
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
        if record_assistant_call:
            self._record_assistant_tool_call(
                conversation,
                tool_call=normalized_call,
                provider_id=provider_id,
                response_id=response_id,
                metadata=metadata,
            )
        self._snapshot_before_file_mutation(
            call=normalized_call,
            turn_id=turn_id,
            turn_metadata=turn_metadata,
        )
        try:
            result = tool_router.execute(normalized_call, exposure=tool_exposure)
        except ValueError as exc:
            result = ToolResult(
                success=False,
                summary=f"Tool {normalized_call.name} could not run because its arguments were invalid.",
                error=str(exc),
                raw_payload={
                    "tool_name": normalized_call.name,
                    "arguments": dict(normalized_call.arguments),
                    "error_kind": "tool_validation_error",
                },
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

    def _execute_parallel_batch(
        self,
        *,
        calls: tuple[ToolCall, ...],
        tool_router: ToolRouter,
        tool_exposure: ToolExposure,
        plan_state: PlanState,
        turn_id: str,
        provider_id: str | None,
        response_id: str | None,
        metadata: dict[str, object] | None,
        record_assistant_call: bool,
    ) -> tuple[_ParallelToolOutcome, ...]:
        if len(calls) == 1:
            return (
                self._execute_tool_call_isolated(
                    call=calls[0],
                    tool_router=tool_router,
                    tool_exposure=tool_exposure,
                    plan_state=plan_state,
                    turn_id=turn_id,
                    provider_id=provider_id,
                    response_id=response_id,
                    metadata=metadata,
                    record_assistant_call=record_assistant_call,
                ),
            )
        with ThreadPoolExecutor(max_workers=len(calls)) as executor:
            futures = [
                executor.submit(
                    self._execute_tool_call_isolated,
                    call=call,
                    tool_router=tool_router,
                    tool_exposure=tool_exposure,
                    plan_state=plan_state,
                    turn_id=turn_id,
                    provider_id=provider_id,
                    response_id=response_id,
                    metadata=metadata,
                    record_assistant_call=record_assistant_call,
                )
                for call in calls
            ]
        return tuple(future.result() for future in futures)

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
    ) -> _ParallelToolOutcome:
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
    ) -> PlanState:
        if record_assistant_call:
            self._record_assistant_tool_call(
                conversation,
                tool_call=normalized_call,
                provider_id=provider_id,
                response_id=response_id,
                metadata=metadata,
            )
        next_plan_state = self._apply_tool_effects(
            call=normalized_call,
            result_summary=result.summary,
            result_payload=result.raw_payload,
            plan_state=plan_state,
        )
        tool_transcript_content = self._context_manager.render_tool_result(
            result,
            tool_name=normalized_call.name,
        )
        guarded_tool_transcript_content = (
            tool_transcript_content
            if normalized_call.name == "Skill"
            else self._injection_guard.guard_tool_output(tool_transcript_content)
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
        )
        self._hook_manager.execute(
            HookPoint.POST_TOOL_USE,
            HookContext(
                hook_point=HookPoint.POST_TOOL_USE,
                tool_name=normalized_call.name,
                tool_args=dict(normalized_call.arguments),
                session_id=self._session_id,
                metadata={
                    "result_summary": result.summary[:200],
                    "success": result.success,
                },
            ),
        )
        finish_event = self._tool_activity_event(
            normalized_call,
            phase="finish",
            result_summary=result.summary,
        )
        activity_events.append(finish_event)
        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.TOOL_RESULT,
                text=finish_event.message,
                tool_name=normalized_call.name,
                call_id=normalized_call.call_id,
                metadata={
                    "success": result.success,
                    "summary": result.summary,
                    "error": result.error,
                    "path": result.raw_payload.get("path"),
                    "error_kind": result.raw_payload.get("error_kind"),
                    "raw_payload": dict(result.raw_payload),
                    "transcript_content": guarded_tool_transcript_content,
                    "file_changes": self._file_changes_for_tool_result(
                        call=normalized_call,
                        result_payload=result.raw_payload,
                    ),
                },
            ),
        )
        self._trace_service.append(
            self._session_id,
            RuntimeTraceEvent(
                kind="tool_execution",
                turn_id=turn_id,
                payload={
                    "tool_name": normalized_call.name,
                    "tool_call_id": normalized_call.call_id or "",
                    "arguments": normalized_call.arguments,
                    "summary": result.summary,
                    "success": result.success,
                    "stdout_preview": self._trace_preview(result.raw_payload.get("stdout")),
                    "stderr_preview": self._trace_preview(result.raw_payload.get("stderr")),
                },
            ),
        )
        return next_plan_state

    def _snapshot_before_file_mutation(
        self,
        *,
        call: ToolCall,
        turn_id: str,
        turn_metadata: dict[str, object],
    ) -> None:
        if self._file_history is None or call.name not in FILE_MUTATION_TOOLS:
            return
        paths = self._mutation_paths(call)
        if not paths:
            return
        snapshot_ids: list[str] = []
        errors: list[str] = []
        for path in paths:
            snapshot = self._file_history.snapshot_path(
                session_id=self._session_id,
                turn_id=turn_id,
                raw_path=path,
                tool_name=call.name,
            )
            if snapshot.error:
                errors.append(snapshot.error)
                continue
            snapshot_ids.append(snapshot.snapshot_id)
        if snapshot_ids:
            turn_metadata["file_history_snapshot_ids"] = snapshot_ids
        if errors:
            turn_metadata["file_history_errors"] = errors

    def _mutation_paths(self, call: ToolCall) -> tuple[str, ...]:
        value = call.arguments.get("file_path") or call.arguments.get("path")
        if isinstance(value, str) and value:
            return (value,)
        return ()

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
    ) -> None:
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
                            ResponsesFunctionCallOutputPayload.from_text(
                                content,
                                success=success,
                            ).to_dict()
                        ),
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
                },
            )
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

    def _file_changes_for_tool_result(
        self,
        *,
        call: ToolCall,
        result_payload: dict[str, object],
    ) -> list[dict[str, object]]:
        if call.name in FILE_MUTATION_TOOLS:
            path = result_payload.get("path") or call.arguments.get("file_path") or call.arguments.get("path")
            if isinstance(path, str) and path:
                return [{"kind": call.name, "path": path}]
        return []

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
        if call.name == "Bash":
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
        if call.name == "Bash":
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

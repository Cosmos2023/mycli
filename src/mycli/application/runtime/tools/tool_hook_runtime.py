from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.tooling.calls import ToolCall
from mycli.services.hooks import (
    HookAction,
    HookContext,
    HookExecutionSummary,
    HookManager,
    HookPoint,
    HookResult,
)
from mycli.tools.base import ToolResult


@dataclass(frozen=True, slots=True)
class PreToolHookResult:
    call: ToolCall
    summaries: tuple[HookExecutionSummary, ...]
    denied_result: ToolResult | None = None


@dataclass(frozen=True, slots=True)
class PostToolHookResult:
    result: ToolResult
    summaries: tuple[HookExecutionSummary, ...]
    additional_contexts: tuple[str, ...]


@dataclass(slots=True)
class ToolHookRuntime:
    """Coordinates hook execution around a tool call."""

    session_id: str
    hook_manager: HookManager

    def set_session_id(self, session_id: str) -> None:
        self.session_id = session_id

    def before_tool_use(self, *, call: ToolCall, turn_id: str) -> PreToolHookResult:
        pre_hook_execution = self.hook_manager.execute_with_summary(
            HookPoint.PRE_TOOL_USE,
            HookContext(
                hook_point=HookPoint.PRE_TOOL_USE,
                tool_name=call.name,
                tool_args=dict(call.arguments),
                session_id=self.session_id,
                metadata={"turn_id": turn_id},
            ),
        )
        updated_call = call
        for hook_result in pre_hook_execution.results:
            if hook_result.action is HookAction.DENY:
                return PreToolHookResult(
                    call=updated_call,
                    summaries=pre_hook_execution.summaries,
                    denied_result=self._denied_tool_result(
                        call=updated_call,
                        message=hook_result.message,
                    ),
                )
            if hook_result.action is HookAction.MODIFY and hook_result.modified_args:
                updated_call = ToolCall(
                    name=updated_call.name,
                    arguments={**updated_call.arguments, **hook_result.modified_args},
                    reason=updated_call.reason,
                    call_id=updated_call.call_id,
                )
        return PreToolHookResult(
            call=updated_call,
            summaries=pre_hook_execution.summaries,
        )

    def after_tool_use(
        self,
        *,
        call: ToolCall,
        turn_id: str,
        result: ToolResult,
    ) -> PostToolHookResult:
        post_hook_execution = self.hook_manager.execute_with_summary(
            HookPoint.POST_TOOL_USE,
            HookContext(
                hook_point=HookPoint.POST_TOOL_USE,
                tool_name=call.name,
                tool_args=dict(call.arguments),
                session_id=self.session_id,
                metadata={
                    "turn_id": turn_id,
                    "result_summary": result.summary[:200],
                    "success": result.success,
                },
            ),
        )
        return PostToolHookResult(
            result=_apply_post_hook_results(result, post_hook_execution.results),
            summaries=post_hook_execution.summaries,
            additional_contexts=_post_hook_additional_contexts(post_hook_execution.results),
        )

    def _denied_tool_result(self, *, call: ToolCall, message: str | None) -> ToolResult:
        return ToolResult(
            success=False,
            summary=f"Tool denied: {message or call.name}",
            error=message or "tool denied by hook",
            raw_payload={
                "tool_name": call.name,
                "arguments": dict(call.arguments),
                "error_kind": "tool_denied_by_hook",
            },
        )


def _apply_post_hook_results(
    result: ToolResult,
    hook_results: tuple[HookResult, ...],
) -> ToolResult:
    updated = result
    for hook_result in hook_results:
        action = hook_result.action
        message = hook_result.message
        modified_args = hook_result.modified_args
        if action is HookAction.DENY:
            updated = ToolResult(
                success=False,
                summary=f"Tool result denied by hook: {message or updated.summary}",
                artifacts=updated.artifacts,
                raw_payload={
                    **updated.raw_payload,
                    "error_kind": "tool_denied_by_post_hook",
                },
                evidence=updated.evidence,
                error=message or "tool result denied by hook",
            )
        elif action is HookAction.MODIFY and isinstance(modified_args, dict):
            updated = _with_post_hook_modifications(updated, modified_args)
    return updated


def _post_hook_additional_contexts(
    hook_results: tuple[HookResult, ...],
) -> tuple[str, ...]:
    contexts: list[str] = []
    for hook_result in hook_results:
        for context in hook_result.additional_contexts:
            if context.strip():
                contexts.append(context)
    return tuple(contexts)


def _with_post_hook_modifications(
    result: ToolResult,
    modified_args: dict[str, object],
) -> ToolResult:
    summary = result.summary
    error = result.error
    raw_payload = dict(result.raw_payload)
    raw_changes = modified_args.get("raw_payload")
    if isinstance(raw_changes, dict):
        for key, value in raw_changes.items():
            if isinstance(key, str) and key:
                raw_payload[key] = value
    summary_value = modified_args.get("summary")
    if isinstance(summary_value, str) and summary_value.strip():
        summary = summary_value.strip()
    error_value = modified_args.get("error")
    if isinstance(error_value, str):
        error = error_value.strip() or None
    return ToolResult(
        success=result.success,
        summary=summary,
        artifacts=result.artifacts,
        raw_payload=raw_payload,
        evidence=result.evidence,
        error=error,
    )

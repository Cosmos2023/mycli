from __future__ import annotations

from collections import deque
from collections.abc import Callable
from html import escape
from typing import Protocol
from uuid import uuid4

from mycli.application.runtime.subagents.loop import SubAgentChildLoop
from mycli.application.runtime.subagents.profiles import get_sub_agent_profile
from mycli.application.runtime.subagents.tool_scope import resolve_child_tool_scope
from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.domain.subagents import (
    SubAgentInvocation,
    SubAgentResult,
    SubAgentRunSummary,
)


class SupportsHistoryLoad(Protocol):
    def load_history_items(self, session_id: str) -> tuple[HistoryItem, ...]: ...


class SubAgentService:
    def __init__(
        self,
        *,
        session_id: str,
        turn_id_provider: Callable[[], str],
        parent_tool_names: Callable[[], tuple[str, ...]],
        child_loop: SubAgentChildLoop,
        policy_denied_tools: Callable[[], tuple[str, ...]] | None = None,
        session_service: SupportsHistoryLoad | None = None,
        max_recent_runs: int = 20,
    ) -> None:
        self._session_id = session_id
        self._turn_id_provider = turn_id_provider
        self._parent_tool_names = parent_tool_names
        self._policy_denied_tools = policy_denied_tools or (lambda: ())
        self._session_service = session_service
        self._child_loop = child_loop
        self._recent_runs: deque[SubAgentRunSummary] = deque(maxlen=max_recent_runs)

    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
    ) -> SubAgentResult:
        turn_id = self._turn_id_provider()
        invocation = SubAgentInvocation(
            agent_type=agent_type,
            description=description,
            allowed_tools=allowed_tools,
            parent_session_id=self._session_id,
            parent_turn_id=turn_id,
        )
        child_session_id = self._child_session_id(turn_id)
        profile = get_sub_agent_profile(agent_type)
        if profile is None:
            result = SubAgentResult(
                status="failed",
                report=self._xml_report(
                    agent=agent_type,
                    status="failed",
                    tool_calls=0,
                    child_session_id=child_session_id,
                    body=f"Unknown sub-agent profile: {agent_type}",
                    limit=8000,
                ),
                child_session_id=child_session_id,
                tool_calls=0,
                error=f"Unknown sub-agent profile: {agent_type}",
            )
            self._record(invocation, result)
            return result
        tool_names = resolve_child_tool_scope(
            parent_tools=self._parent_tool_names(),
            requested_tools=allowed_tools,
            profile=profile,
            policy_denied_tools=self._policy_denied_tools(),
        )
        loop_result = self._child_loop.run(
            invocation=invocation,
            profile=profile,
            child_session_id=child_session_id,
            tool_names=tool_names,
        )
        result = SubAgentResult(
            status=loop_result.status,
            report=self._xml_report(
                agent=agent_type,
                status=loop_result.status,
                tool_calls=loop_result.tool_calls,
                child_session_id=child_session_id,
                body=loop_result.report,
                limit=profile.budget.report_char_limit,
            ),
            child_session_id=child_session_id,
            tool_calls=loop_result.tool_calls,
            error=loop_result.error,
        )
        self._record(invocation, result)
        return result

    def recent_runs(self) -> tuple[SubAgentRunSummary, ...]:
        return tuple(self._recent_runs)

    def inspect_transcript(self, child_session_id: str) -> tuple[str, ...]:
        if self._session_service is None:
            return (f"sub-agent transcript not found: {child_session_id}",)
        items = self._session_service.load_history_items(child_session_id)
        if not items:
            return (f"sub-agent transcript not found: {child_session_id}",)
        return (self._transcript_header(child_session_id),) + tuple(
            self._format_transcript_item(item) for item in items
        )

    def _record(self, invocation: SubAgentInvocation, result: SubAgentResult) -> None:
        self._recent_runs.appendleft(
            SubAgentRunSummary.from_result(invocation=invocation, result=result)
        )

    def _child_session_id(self, turn_id: str) -> str:
        return f"{self._session_id}:sub:{turn_id}:{uuid4().hex[:8]}"

    def _transcript_header(self, child_session_id: str) -> str:
        for summary in self._recent_runs:
            if summary.child_session_id == child_session_id:
                return (
                    f"{summary.agent_type} {summary.status} mode={summary.mode} "
                    f"tools={summary.tool_calls} {child_session_id}"
                )
        return child_session_id

    def _format_transcript_item(self, item: HistoryItem) -> str:
        if item.type is HistoryItemType.TOOL_CALL:
            args = item.metadata.get("arguments", {})
            return f"  tool_call {item.tool_name or ''} {item.call_id or ''} {args}"
        if item.type is HistoryItemType.TOOL_RESULT:
            text = item.text or ""
            preview = text.replace("\n", "\\n")[:500]
            return (
                f"  tool_result {item.tool_name or ''} {item.call_id or ''} "
                f"{len(text)} chars {preview}"
            )
        if item.type is HistoryItemType.ASSISTANT_MESSAGE:
            status = item.metadata.get("sub_agent_status")
            label = f"final {status}" if isinstance(status, str) else "assistant"
            return f"  {label} {(item.text or '').replace(chr(10), ' ')[:500]}"
        if item.type is HistoryItemType.USER_MESSAGE and item.metadata.get("role") == "system":
            return f"  system {(item.text or '').replace(chr(10), ' ')[:500]}"
        return f"  user {(item.text or '').replace(chr(10), ' ')[:500]}"

    def _xml_report(
        self,
        *,
        agent: str,
        status: str,
        tool_calls: int,
        child_session_id: str,
        body: str,
        limit: int,
    ) -> str:
        report_body = body
        if len(report_body) > limit:
            report_body = report_body[:limit] + "\n[truncated: sub-agent report exceeded limit]"
        return (
            f'<sub-agent-report agent="{escape(agent)}" status="{escape(status)}" '
            f'tools="{tool_calls}" child_session_id="{escape(child_session_id)}">'
            f"\n{escape(report_body)}\n</sub-agent-report>"
        )


__all__ = ["SubAgentService"]

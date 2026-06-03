from __future__ import annotations

from collections import deque
from collections.abc import Callable
from concurrent.futures import TimeoutError, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from html import escape
from threading import Lock
from time import monotonic
from typing import Any, Protocol
from uuid import uuid4

from mycli.application.runtime.subagents.loop import SubAgentChildLoop
from mycli.application.runtime.subagents.transcript import SubAgentTranscriptRecorder
from mycli.application.runtime.subagents.tool_scope import resolve_child_tool_scope
from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.domain.subagents import (
    SubAgentInvocation,
    SubAgentProfile,
    SubAgentResult,
    SubAgentRunSummary,
)


class SupportsHistorySession(Protocol):
    def append_history_items(self, session_id: str, items: tuple[HistoryItem, ...]) -> None: ...

    def load_history_items(self, session_id: str) -> tuple[HistoryItem, ...]: ...


class SupportsFuture(Protocol):
    def result(self, timeout: float | None = None) -> Any: ...


class SupportsBackgroundExecutor(Protocol):
    def submit(self, fn: Callable[..., None], *args: object, **kwargs: object) -> SupportsFuture:
        ...


class SupportsLock(Protocol):
    def __enter__(self) -> object: ...

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> object: ...


@dataclass(slots=True)
class _BackgroundRun:
    invocation: SubAgentInvocation
    started_at: str
    future: SupportsFuture
    tool_calls: int = 0


class SubAgentService:
    def __init__(
        self,
        *,
        session_id: str,
        turn_id_provider: Callable[[], str],
        parent_tool_names: Callable[[], tuple[str, ...]],
        child_loop: SubAgentChildLoop,
        profile_lookup: Callable[[str], SubAgentProfile | None] | None = None,
        policy_denied_tools: Callable[[], tuple[str, ...]] | None = None,
        session_service: SupportsHistorySession | None = None,
        max_recent_runs: int = 20,
        background_executor: SupportsBackgroundExecutor | None = None,
        max_concurrent_background_tasks: int = 2,
        run_state_lock: SupportsLock | None = None,
    ) -> None:
        self._session_id = session_id
        self._turn_id_provider = turn_id_provider
        self._parent_tool_names = parent_tool_names
        self._profile_lookup = profile_lookup or _builtin_profile_lookup
        self._policy_denied_tools = policy_denied_tools or (lambda: ())
        self._session_service = session_service
        self._child_loop = child_loop
        self._recent_runs: deque[SubAgentRunSummary] = deque(maxlen=max_recent_runs)
        self._background_executor = background_executor or ThreadPoolExecutor(
            max_workers=max_concurrent_background_tasks,
            thread_name_prefix="mycli-subagent",
        )
        self._owns_background_executor = background_executor is None
        self._max_concurrent_background_tasks = max_concurrent_background_tasks
        self._running_background: dict[str, _BackgroundRun] = {}
        self._run_state_lock = run_state_lock or Lock()

    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
        mode: str = "sync",
    ) -> SubAgentResult:
        turn_id = self._turn_id_provider()
        invocation = SubAgentInvocation(
            agent_type=agent_type,
            description=description,
            allowed_tools=allowed_tools,
            parent_session_id=self._session_id,
            parent_turn_id=turn_id,
            mode=mode,
        )
        child_session_id = self._child_session_id(turn_id)
        if invocation.mode == "background":
            return self._run_background(invocation, child_session_id)
        return self._run_sync_invocation(invocation, child_session_id)

    def _run_sync_invocation(
        self,
        invocation: SubAgentInvocation,
        child_session_id: str,
    ) -> SubAgentResult:
        profile = self._profile_lookup(invocation.agent_type)
        if profile is None:
            result = SubAgentResult(
                status="failed",
                report=self._xml_report(
                    agent=invocation.agent_type,
                    status="failed",
                    tool_calls=0,
                    child_session_id=child_session_id,
                    body=f"Unknown sub-agent profile: {invocation.agent_type}",
                    limit=8000,
                ),
                child_session_id=child_session_id,
                tool_calls=0,
                error=f"Unknown sub-agent profile: {invocation.agent_type}",
            )
            self._record(invocation, result)
            return result
        tool_names = resolve_child_tool_scope(
            parent_tools=self._parent_tool_names(),
            requested_tools=invocation.allowed_tools,
            profile=profile,
            policy_denied_tools=self._policy_denied_tools(),
        )
        loop_result = self._child_loop.run(
            invocation=invocation,
            profile=profile,
            child_session_id=child_session_id,
            tool_names=tool_names,
            transcript=self._transcript_recorder(invocation, child_session_id),
        )
        result = SubAgentResult(
            status=loop_result.status,
            report=self._xml_report(
                agent=invocation.agent_type,
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
        with self._run_state_lock:
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

    def shutdown(self, *, timeout_seconds: float = 2.0) -> None:
        deadline = monotonic() + timeout_seconds
        with self._run_state_lock:
            runs = tuple(self._running_background.items())
        for child_session_id, run in runs:
            remaining = max(0.0, deadline - monotonic())
            try:
                run.future.result(timeout=remaining)
            except TimeoutError:
                failed = SubAgentResult(
                    status="failed",
                    report=self._xml_report(
                        agent=run.invocation.agent_type,
                        status="failed",
                        tool_calls=run.tool_calls,
                        child_session_id=child_session_id,
                        body="Background sub-agent shutdown timeout.",
                        limit=8000,
                    ),
                    child_session_id=child_session_id,
                    tool_calls=run.tool_calls,
                    error="Background sub-agent shutdown timeout.",
                )
                self._mark_background_finished(run.invocation, failed, run.started_at)
        if self._owns_background_executor:
            shutdown = getattr(self._background_executor, "shutdown", None)
            if callable(shutdown):
                shutdown(wait=False)

    def _run_background(
        self,
        invocation: SubAgentInvocation,
        child_session_id: str,
    ) -> SubAgentResult:
        with self._run_state_lock:
            if len(self._running_background) >= self._max_concurrent_background_tasks:
                limit_reached = True
            else:
                limit_reached = False
        if limit_reached:
            return self._background_limit_result(invocation, child_session_id)
        started_at = self._timestamp()
        running = SubAgentResult(
            status="running",
            report=self._xml_report(
                agent=invocation.agent_type,
                status="running",
                tool_calls=0,
                child_session_id=child_session_id,
                body="Sub-agent started in background. Use /subagents to inspect it.",
                limit=8000,
                mode=invocation.mode,
            ),
            child_session_id=child_session_id,
            tool_calls=0,
        )
        self._record(invocation, running, started_at=started_at, completed_at=None)

        def run_child() -> None:
            try:
                final_result = self._run_sync_invocation(invocation, child_session_id)
            except Exception as exc:
                final_result = SubAgentResult(
                    status="failed",
                    report=self._xml_report(
                        agent=invocation.agent_type,
                        status="failed",
                        tool_calls=0,
                        child_session_id=child_session_id,
                        body=f"Background sub-agent failed: {exc}",
                        limit=8000,
                    ),
                    child_session_id=child_session_id,
                    tool_calls=0,
                    error=str(exc),
                )
            self._mark_background_finished(invocation, final_result, started_at)

        future = self._background_executor.submit(run_child)
        try:
            future.result(timeout=0)
        except TimeoutError:
            pass
        with self._run_state_lock:
            if self._has_finished_record_unlocked(child_session_id):
                return running
            self._running_background[child_session_id] = _BackgroundRun(
                invocation=invocation,
                started_at=started_at,
                future=future,
            )
        return running

    def _background_limit_result(
        self,
        invocation: SubAgentInvocation,
        child_session_id: str,
    ) -> SubAgentResult:
        result = SubAgentResult(
            status="failed",
            report=self._xml_report(
                agent=invocation.agent_type,
                status="failed",
                tool_calls=0,
                child_session_id=child_session_id,
                body="Background sub-agent concurrency limit reached.",
                limit=8000,
                mode=invocation.mode,
            ),
            child_session_id=child_session_id,
            tool_calls=0,
            error="Background sub-agent concurrency limit reached.",
        )
        self._record(invocation, result)
        return result

    def _mark_background_finished(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        started_at: str,
    ) -> None:
        with self._run_state_lock:
            self._running_background.pop(result.child_session_id, None)
            self._replace_record_unlocked(
                invocation,
                result,
                started_at=started_at,
                completed_at=self._timestamp(),
            )

    def _record(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        *,
        started_at: str | None = None,
        completed_at: str | None = None,
    ) -> None:
        with self._run_state_lock:
            self._record_unlocked(
                invocation,
                result,
                started_at=started_at,
                completed_at=completed_at,
            )

    def _record_unlocked(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        *,
        started_at: str | None,
        completed_at: str | None,
    ) -> None:
        self._recent_runs.appendleft(
            SubAgentRunSummary.from_result(
                invocation=invocation,
                result=result,
                started_at=started_at,
                completed_at=completed_at,
            )
        )

    def _replace_record_unlocked(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        *,
        started_at: str | None,
        completed_at: str | None,
    ) -> None:
        self._recent_runs = deque(
            (
                summary
                for summary in self._recent_runs
                if summary.child_session_id != result.child_session_id
            ),
            maxlen=self._recent_runs.maxlen,
        )
        self._record_unlocked(
            invocation,
            result,
            started_at=started_at,
            completed_at=completed_at,
        )

    def _has_finished_record_unlocked(self, child_session_id: str) -> bool:
        return any(
            summary.child_session_id == child_session_id and summary.status != "running"
            for summary in self._recent_runs
        )

    def _child_session_id(self, turn_id: str) -> str:
        return f"{self._session_id}:sub:{turn_id}:{uuid4().hex[:8]}"

    def _transcript_recorder(
        self,
        invocation: SubAgentInvocation,
        child_session_id: str,
    ) -> SubAgentTranscriptRecorder | None:
        if self._session_service is None:
            return None
        return SubAgentTranscriptRecorder(
            session_service=self._session_service,
            parent_session_id=invocation.parent_session_id,
            child_session_id=child_session_id,
            parent_turn_id=invocation.parent_turn_id,
        )

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
        mode: str | None = None,
    ) -> str:
        report_body = body
        if len(report_body) > limit:
            report_body = report_body[:limit] + "\n[truncated: sub-agent report exceeded limit]"
        mode_attr = "" if mode is None else f' mode="{escape(mode)}"'
        return (
            f'<sub-agent-report agent="{escape(agent)}" status="{escape(status)}" '
            f'tools="{tool_calls}" child_session_id="{escape(child_session_id)}"{mode_attr}>'
            f"\n{escape(report_body)}\n</sub-agent-report>"
        )

    def _timestamp(self) -> str:
        return datetime.now(UTC).isoformat()


__all__ = ["SubAgentService"]


def _builtin_profile_lookup(profile_id: str) -> SubAgentProfile | None:
    from mycli.domain.subagent_profiles import get_sub_agent_profile

    return get_sub_agent_profile(profile_id)

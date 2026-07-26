from __future__ import annotations

import hashlib
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any, Protocol
from uuid import uuid4

from mycli.application.runtime.subagents.loop import SubAgentChildLoop
from mycli.application.runtime.subagents.tool_scope import resolve_child_tool_scope
from mycli.application.runtime.subagents.transcript import SubAgentTranscriptRecorder
from mycli.domain.runtime import (
    BackgroundJobSummary,
    ContextBaseline,
    HistoryItem,
    HistoryItemType,
    RuntimeStreamEvent,
    RuntimeInterruptToken,
)
from mycli.domain.runtime.background_jobs import BackgroundJobState
from mycli.domain.runtime.task_notifications import TaskNotification
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.domain.subagents import (
    SubAgentContextSnapshot,
    SubAgentInvocation,
    SubAgentMessageResult,
    SubAgentOutput,
    SubAgentProfile,
    SubAgentResult,
    SubAgentRunSummary,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.services.subagents.tool_result_payload import (
    BACKGROUND_SUBAGENT_NOTIFICATION_GUIDANCE,
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


class SupportsTraceAppend(Protocol):
    def append(self, session_id: str, event: RuntimeTraceEvent) -> None: ...


@dataclass(slots=True)
class _BackgroundRun:
    invocation: SubAgentInvocation
    started_at: str
    future: SupportsFuture
    interrupt_token: RuntimeInterruptToken
    tool_calls: int = 0
    cancelled: bool = False
    pending_messages: deque[str] = field(default_factory=deque)


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
        context_baseline_provider: Callable[[], ContextBaseline | None] | None = None,
        memory_fence_provider: Callable[[], str] | None = None,
        session_summary_provider: Callable[[], str] | None = None,
        trace_service: SupportsTraceAppend | None = None,
        session_service: SupportsHistorySession | None = None,
        max_recent_runs: int = 20,
        background_executor: SupportsBackgroundExecutor | None = None,
        max_concurrent_background_tasks: int = 2,
        run_state_lock: SupportsLock | None = None,
        notification_sink: Callable[[str], tuple[tuple[str, ...], tuple[str, ...]]] | None = None,
        task_output_path_provider: Callable[[str], Path] | None = None,
    ) -> None:
        self._session_id = session_id
        self._turn_id_provider = turn_id_provider
        self._parent_tool_names = parent_tool_names
        self._profile_lookup = profile_lookup or _builtin_profile_lookup
        self._policy_denied_tools = policy_denied_tools or (lambda: ())
        self._context_baseline_provider = context_baseline_provider or (lambda: None)
        self._memory_fence_provider = memory_fence_provider or (lambda: "")
        self._session_summary_provider = session_summary_provider or (lambda: "")
        self._trace_service = trace_service
        self._session_service = session_service
        self._child_loop = child_loop
        self._recent_runs: deque[SubAgentRunSummary] = deque(maxlen=max_recent_runs)
        self._outputs: dict[str, SubAgentOutput] = {}
        self._background_executor = background_executor or ThreadPoolExecutor(
            max_workers=max_concurrent_background_tasks,
            thread_name_prefix="mycli-subagent",
        )
        self._owns_background_executor = background_executor is None
        self._max_concurrent_background_tasks = max_concurrent_background_tasks
        self._running_background: dict[str, _BackgroundRun] = {}
        self._run_state_lock = run_state_lock or Lock()
        self._stream_sink: Callable[[RuntimeStreamEvent], None] | None = None
        self._notification_sink = notification_sink
        self._task_output_path_provider = task_output_path_provider

    def set_stream_sink(self, stream_sink: Callable[[RuntimeStreamEvent], None] | None) -> None:
        self._stream_sink = stream_sink

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
        *,
        persist_snapshot: bool = True,
        record_result: bool = True,
        initial_messages: list[dict[str, object]] | None = None,
        pending_message_provider: Callable[[], tuple[str, ...]] | None = None,
        prior_tool_calls: int = 0,
        interrupt_token: RuntimeInterruptToken | None = None,
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
            if record_result:
                self._record(
                    invocation,
                    result,
                    snapshot_report=f"Unknown sub-agent profile: {invocation.agent_type}",
                    persist_snapshot=persist_snapshot,
                )
            return result
        tool_names = resolve_child_tool_scope(
            parent_tools=self._parent_tool_names(),
            requested_tools=invocation.allowed_tools,
            profile=profile,
            policy_denied_tools=self._policy_denied_tools(),
        )
        context_snapshot = self._context_snapshot(tool_names)
        self._trace_context_fork(invocation, child_session_id, context_snapshot)
        loop_result = self._child_loop.run(
            invocation=invocation,
            profile=profile,
            child_session_id=child_session_id,
            tool_names=tool_names,
            context_snapshot=context_snapshot,
            transcript=self._transcript_recorder(invocation, child_session_id),
            initial_messages=initial_messages,
            pending_message_provider=pending_message_provider,
            interrupt_token=interrupt_token,
        )
        context_diagnostics = (
            loop_result.context_diagnostics or dict(context_snapshot.diagnostics)
        )
        result = SubAgentResult(
            status=loop_result.status,
            report=self._xml_report(
                agent=invocation.agent_type,
                status=loop_result.status,
                tool_calls=prior_tool_calls + loop_result.tool_calls,
                child_session_id=child_session_id,
                body=loop_result.report,
                limit=profile.budget.report_char_limit,
            ),
            child_session_id=child_session_id,
            tool_calls=prior_tool_calls + loop_result.tool_calls,
            error=loop_result.error,
            context_diagnostics=context_diagnostics,
        )
        if record_result:
            self._record(
                invocation,
                result,
                snapshot_report=loop_result.report,
                persist_snapshot=persist_snapshot,
            )
        return result

    def recent_runs(self) -> tuple[SubAgentRunSummary, ...]:
        with self._run_state_lock:
            return tuple(self._recent_runs)

    def background_jobs(self) -> tuple[BackgroundJobSummary, ...]:
        with self._run_state_lock:
            summaries = tuple(self._recent_runs)
            running_ids = set(self._running_background)
        jobs: list[BackgroundJobSummary] = []
        for summary in summaries:
            if summary.mode != "background":
                continue
            state = _background_job_state(summary.status)
            if summary.child_session_id in running_ids:
                state = "running"
            jobs.append(
                BackgroundJobSummary(
                    job_id=f"subagent:{summary.child_session_id}",
                    owner="subagent",
                    state=state,
                    owner_turn_id=summary.parent_turn_id or None,
                    started_at=summary.started_at,
                    last_event_at=summary.completed_at or summary.started_at,
                    completed_at=summary.completed_at,
                    terminal_summary=summary.status if summary.status != "running" else None,
                )
            )
        return tuple(jobs)

    def cancel_background_jobs(self) -> tuple[BackgroundJobSummary, ...]:
        cancelled: list[BackgroundJobSummary] = []
        interrupt_tokens: list[RuntimeInterruptToken] = []
        with self._run_state_lock:
            runs = tuple(self._running_background.items())
            for child_session_id, run in runs:
                run.cancelled = True
                interrupt_tokens.append(run.interrupt_token)
                result = self._cancelled_background_result(
                    run.invocation,
                    child_session_id,
                    tool_calls=run.tool_calls,
                )
                completed_at = self._timestamp()
                self._running_background.pop(child_session_id, None)
                self._replace_record_unlocked(
                    run.invocation,
                    result,
                    started_at=run.started_at,
                    completed_at=completed_at,
                )
                cancelled.append(
                    BackgroundJobSummary(
                        job_id=f"subagent:{child_session_id}",
                        owner="subagent",
                        state="cancelled",
                        owner_turn_id=run.invocation.parent_turn_id,
                        started_at=run.started_at,
                        last_event_at=completed_at,
                        completed_at=completed_at,
                        terminal_summary="cancelled",
                    )
                )
        for interrupt_token in interrupt_tokens:
            interrupt_token.request("subagent_cancelled")
        for summary in cancelled:
            child_session_id = summary.job_id.removeprefix("subagent:")
            matched_run = next(
                (
                    running
                    for running_id, running in runs
                    if running_id == child_session_id
                ),
                None,
            )
            if matched_run is None:
                continue
            result = self._cancelled_background_result(
                matched_run.invocation,
                child_session_id,
                tool_calls=matched_run.tool_calls,
            )
            self._write_subagent_snapshot(
                matched_run.invocation,
                result,
                started_at=matched_run.started_at,
                completed_at=summary.completed_at,
                snapshot_report="Background sub-agent cancelled by user.",
            )
            self._write_task_output(result)
            if summary.completed_at is not None:
                self._emit_completion_notification(
                    run.invocation,
                    result,
                    completed_at=summary.completed_at,
                )
        return tuple(cancelled)

    def cancel_background_job(self, child_session_id: str) -> tuple[BackgroundJobSummary, ...]:
        child_session_id = child_session_id.strip()
        if child_session_id.startswith("subagent:"):
            child_session_id = child_session_id.removeprefix("subagent:")
        if not child_session_id:
            return ()
        with self._run_state_lock:
            run = self._running_background.get(child_session_id)
            if run is None:
                return ()
            run.cancelled = True
            interrupt_token = run.interrupt_token
            result = self._cancelled_background_result(
                run.invocation,
                child_session_id,
                tool_calls=run.tool_calls,
            )
            completed_at = self._timestamp()
            self._running_background.pop(child_session_id, None)
            self._replace_record_unlocked(
                run.invocation,
                result,
                started_at=run.started_at,
                completed_at=completed_at,
            )
            summary = BackgroundJobSummary(
                job_id=f"subagent:{child_session_id}",
                owner="subagent",
                state="cancelled",
                owner_turn_id=run.invocation.parent_turn_id,
                started_at=run.started_at,
                last_event_at=completed_at,
                completed_at=completed_at,
                terminal_summary="cancelled",
            )
        interrupt_token.request("subagent_cancelled")
        self._write_subagent_snapshot(
            run.invocation,
            result,
            started_at=run.started_at,
            completed_at=completed_at,
            snapshot_report="Background sub-agent cancelled by user.",
        )
        self._write_task_output(result)
        self._emit_completion_notification(
            run.invocation,
            result,
            completed_at=completed_at,
        )
        return (summary,)

    def inspect_transcript(self, child_session_id: str) -> tuple[str, ...]:
        if self._session_service is None:
            return (f"sub-agent transcript not found: {child_session_id}",)
        items = self._session_service.load_history_items(child_session_id)
        if not items:
            return (f"sub-agent transcript not found: {child_session_id}",)
        return (self._transcript_header(child_session_id),) + tuple(
            self._format_transcript_item(item) for item in items
        )

    def read_output(self, child_session_id: str) -> SubAgentOutput:
        with self._run_state_lock:
            summary = self._summary_for_child_unlocked(child_session_id)
            running = child_session_id in self._running_background
            cached = self._outputs.get(child_session_id)
        transcript_lines = self.inspect_transcript(child_session_id)
        report = self._final_report_from_transcript(child_session_id)
        if summary is None:
            return SubAgentOutput(
                child_session_id=child_session_id,
                status="missing",
                report=f"sub-agent output not found: {child_session_id}",
                tool_calls=0,
                error=f"sub-agent output not found: {child_session_id}",
                transcript_lines=transcript_lines,
            )
        status = "running" if running else summary.status
        if cached is not None:
            cached_report = (
                self._output_report_from_summary(summary)
                if status == "running"
                else cached.report
            )
            return SubAgentOutput(
                child_session_id=child_session_id,
                status=status,
                report=cached_report,
                tool_calls=summary.tool_calls,
                error=summary.error,
                transcript_lines=transcript_lines,
            )
        return SubAgentOutput(
            child_session_id=child_session_id,
            status=status,
            report=report or self._output_report_from_summary(summary),
            tool_calls=summary.tool_calls,
            error=summary.error,
            transcript_lines=transcript_lines,
        )

    def send_message(self, child_session_id: str, message: str) -> SubAgentMessageResult:
        child_session_id = child_session_id.strip()
        message = message.strip()
        if not child_session_id:
            return SubAgentMessageResult(
                child_session_id="",
                accepted=False,
                delivery="invalid",
                error="SendMessage requires child_session_id.",
            )
        if not message:
            return SubAgentMessageResult(
                child_session_id=child_session_id,
                accepted=False,
                delivery="invalid",
                error="SendMessage requires a non-empty message.",
            )
        with self._run_state_lock:
            running = self._running_background.get(child_session_id)
            if running is not None and not running.cancelled:
                running.pending_messages.append(message)
                return SubAgentMessageResult(
                    child_session_id=child_session_id,
                    accepted=True,
                    delivery="queued",
                )
            summary = self._summary_for_child_unlocked(child_session_id)
        if summary is None:
            return SubAgentMessageResult(
                child_session_id=child_session_id,
                accepted=False,
                delivery="missing",
                error=f"Sub-agent not found: {child_session_id}",
            )
        initial_messages = self._resume_messages(child_session_id)
        if not initial_messages:
            return SubAgentMessageResult(
                child_session_id=child_session_id,
                accepted=False,
                delivery="unavailable",
                error=f"Sub-agent transcript is unavailable: {child_session_id}",
            )
        allowed_tools = summary.allowed_tools or self._parent_tool_names()
        invocation = SubAgentInvocation(
            agent_type=summary.agent_type,
            description=summary.description,
            allowed_tools=allowed_tools,
            parent_session_id=self._session_id,
            parent_turn_id=self._turn_id_provider(),
            mode="background",
        )
        started = self._run_background(
            invocation,
            child_session_id,
            initial_messages=initial_messages,
            initial_pending_messages=(message,),
            initial_tool_calls=summary.tool_calls,
        )
        if started.status != "running":
            return SubAgentMessageResult(
                child_session_id=child_session_id,
                accepted=False,
                delivery="unavailable",
                error=started.error or "Unable to resume sub-agent.",
            )
        return SubAgentMessageResult(
            child_session_id=child_session_id,
            accepted=True,
            delivery="resumed",
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
        *,
        initial_messages: list[dict[str, object]] | None = None,
        initial_pending_messages: tuple[str, ...] = (),
        initial_tool_calls: int = 0,
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
                tool_calls=initial_tool_calls,
                child_session_id=child_session_id,
                body="Sub-agent started in background. Use /tasks agents to inspect it.",
                limit=8000,
                mode=invocation.mode,
            ),
            child_session_id=child_session_id,
            tool_calls=initial_tool_calls,
        )
        self._record(invocation, running, started_at=started_at, completed_at=None)
        pending_messages = deque(initial_pending_messages)
        interrupt_token = RuntimeInterruptToken(source=f"subagent:{child_session_id}")

        def drain_pending_messages() -> tuple[str, ...]:
            with self._run_state_lock:
                drained = tuple(pending_messages)
                pending_messages.clear()
            return drained

        def run_child() -> None:
            resumed_messages = initial_messages
            prior_tool_calls = initial_tool_calls
            while True:
                try:
                    final_result = self._run_sync_invocation(
                        invocation,
                        child_session_id,
                        persist_snapshot=False,
                        record_result=False,
                        initial_messages=resumed_messages,
                        pending_message_provider=drain_pending_messages,
                        prior_tool_calls=prior_tool_calls,
                        interrupt_token=interrupt_token,
                    )
                except KeyboardInterrupt:
                    return
                except Exception as exc:
                    final_result = SubAgentResult(
                        status="failed",
                        report=self._xml_report(
                            agent=invocation.agent_type,
                            status="failed",
                            tool_calls=prior_tool_calls,
                            child_session_id=child_session_id,
                            body=f"Background sub-agent failed: {exc}",
                            limit=8000,
                        ),
                        child_session_id=child_session_id,
                        tool_calls=prior_tool_calls,
                        error=str(exc),
                    )
                with self._run_state_lock:
                    run = self._running_background.get(child_session_id)
                    if run is not None and run.cancelled:
                        return
                    if run is not None:
                        run.tool_calls = final_result.tool_calls
                    if run is None and self._has_terminal_record_unlocked(
                        child_session_id,
                        terminal_statuses={"cancelled"},
                    ):
                        return
                    if pending_messages:
                        should_continue = True
                        completed_at = None
                    else:
                        should_continue = False
                        completed_at = self._timestamp()
                        self._running_background.pop(child_session_id, None)
                        self._replace_record_unlocked(
                            invocation,
                            final_result,
                            started_at=started_at,
                            completed_at=completed_at,
                        )
                if should_continue:
                    resumed_messages = self._resume_messages(child_session_id) or resumed_messages
                    prior_tool_calls = final_result.tool_calls
                    continue
                assert completed_at is not None
                self._persist_background_completion(
                    invocation,
                    final_result,
                    started_at=started_at,
                    completed_at=completed_at,
                )
                return

        future = self._background_executor.submit(run_child)
        with suppress(TimeoutError):
            future.result(timeout=0)
        with self._run_state_lock:
            if self._has_finished_record_unlocked(child_session_id):
                return running
            self._running_background[child_session_id] = _BackgroundRun(
                invocation=invocation,
                started_at=started_at,
                future=future,
                interrupt_token=interrupt_token,
                tool_calls=initial_tool_calls,
                pending_messages=pending_messages,
            )
        return running

    def _resume_messages(self, child_session_id: str) -> list[dict[str, object]]:
        if self._session_service is None:
            return []
        messages: list[dict[str, object]] = []
        for item in self._session_service.load_history_items(child_session_id):
            if item.type is HistoryItemType.USER_MESSAGE:
                role = "system" if item.metadata.get("role") == "system" else "user"
                if item.text:
                    messages.append({"role": role, "content": item.text})
                continue
            if item.type is HistoryItemType.CONTEXT_BASELINE_UPDATE:
                if item.text:
                    messages.append({"role": "system", "content": item.text})
                continue
            if item.type is HistoryItemType.ASSISTANT_MESSAGE:
                if item.text:
                    messages.append({"role": "assistant", "content": item.text})
                continue
            if item.type is HistoryItemType.TOOL_CALL and item.tool_name:
                arguments = item.metadata.get("arguments")
                call = ToolCall(
                    name=item.tool_name,
                    arguments=dict(arguments) if isinstance(arguments, dict) else {},
                    reason="resumed child tool call",
                    call_id=item.call_id,
                )
                if messages and messages[-1].get("role") == "assistant":
                    assistant = messages[-1]
                    existing_calls = assistant.get("tool_calls")
                    calls = (
                        tuple(existing_calls)
                        if isinstance(existing_calls, list | tuple)
                        else ()
                    )
                    assistant["tool_calls"] = (*calls, call)
                else:
                    messages.append(
                        {"role": "assistant", "content": "", "tool_calls": (call,)}
                    )
                continue
            if item.type is HistoryItemType.TOOL_RESULT:
                messages.append(
                    {
                        "role": "tool",
                        "tool_name": item.tool_name or "",
                        "tool_call_id": item.call_id,
                        "content": item.text or "",
                    }
                )
        return messages

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
        completed_at = self._timestamp()
        with self._run_state_lock:
            self._running_background.pop(result.child_session_id, None)
            self._replace_record_unlocked(
                invocation,
                result,
                started_at=started_at,
                completed_at=completed_at,
            )
        self._persist_background_completion(
            invocation,
            result,
            started_at=started_at,
            completed_at=completed_at,
        )

    def _persist_background_completion(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        *,
        started_at: str,
        completed_at: str,
    ) -> None:
        self._write_subagent_snapshot(
            invocation,
            result,
            started_at=started_at,
            completed_at=completed_at,
            snapshot_report=self._snapshot_report(result.report),
        )
        self._write_task_output(result)
        self._emit_completion_notification(
            invocation,
            result,
            completed_at=completed_at,
        )

    def _record(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        *,
        started_at: str | None = None,
        completed_at: str | None = None,
        snapshot_report: str | None = None,
        persist_snapshot: bool = True,
    ) -> None:
        with self._run_state_lock:
            self._record_unlocked(
                invocation,
                result,
                started_at=started_at,
                completed_at=completed_at,
            )
        if not persist_snapshot:
            return
        self._write_subagent_snapshot(
            invocation,
            result,
            started_at=started_at,
            completed_at=completed_at,
            snapshot_report=snapshot_report,
        )

    def _record_unlocked(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        *,
        started_at: str | None,
        completed_at: str | None,
    ) -> None:
        self._outputs[result.child_session_id] = SubAgentOutput(
            child_session_id=result.child_session_id,
            status=result.status,
            report=self._snapshot_report(result.report),
            tool_calls=result.tool_calls,
            error=result.error,
            transcript_lines=(),
        )
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

    def _has_terminal_record_unlocked(
        self,
        child_session_id: str,
        *,
        terminal_statuses: set[str],
    ) -> bool:
        return any(
            summary.child_session_id == child_session_id
            and summary.status in terminal_statuses
            for summary in self._recent_runs
        )

    def _cancelled_background_result(
        self,
        invocation: SubAgentInvocation,
        child_session_id: str,
        *,
        tool_calls: int,
    ) -> SubAgentResult:
        body = "Background sub-agent cancelled by user."
        return SubAgentResult(
            status="cancelled",
            report=self._xml_report(
                agent=invocation.agent_type,
                status="cancelled",
                tool_calls=tool_calls,
                child_session_id=child_session_id,
                body=body,
                limit=8000,
                mode=invocation.mode,
            ),
            child_session_id=child_session_id,
            tool_calls=tool_calls,
            error=body,
        )

    def _write_subagent_snapshot(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        *,
        started_at: str | None,
        completed_at: str | None,
        snapshot_report: str | None = None,
    ) -> None:
        if self._session_service is None:
            return
        writer = getattr(self._session_service, "write_subagent_snapshot", None)
        if not callable(writer):
            return
        writer(
            parent_session_id=invocation.parent_session_id,
            child_session_id=result.child_session_id,
            parent_turn_id=invocation.parent_turn_id,
            agent_type=invocation.agent_type,
            status=result.status,
            mode=invocation.mode,
            description=invocation.description,
            report=result.report if snapshot_report is None else snapshot_report,
            tool_calls=result.tool_calls,
            error=result.error,
            started_at=started_at,
            completed_at=completed_at,
            context_diagnostics=dict(result.context_diagnostics),
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
            progress_callback=lambda event: self._emit_progress_event(
                invocation=invocation,
                child_session_id=child_session_id,
                event=event,
            ),
        )

    def _emit_progress_event(
        self,
        *,
        invocation: SubAgentInvocation,
        child_session_id: str,
        event: dict[str, object],
    ) -> None:
        sink = self._stream_sink
        if sink is None:
            return
        tool_calls = event.get("tool_calls")
        payload: dict[str, object] = {
            "subagent": {
                "run_id": self._snapshot_run_id(child_session_id),
                "child_session_id": child_session_id,
                "parent_turn_id": invocation.parent_turn_id,
                "role": invocation.agent_type,
                "description": invocation.description,
                "status": str(event.get("status") or "running"),
                "mode": invocation.mode,
                "summary": str(event.get("summary") or ""),
                "tool_calls": tool_calls if isinstance(tool_calls, int) else None,
                "progress": [event],
            }
        }
        try:
            sink(RuntimeStreamEvent(kind="subagent_update", metadata=payload))
        except Exception:
            return

    def _snapshot_run_id(self, child_session_id: str) -> str:
        digest = hashlib.sha256(child_session_id.encode("utf-8")).hexdigest()[:16]
        return f"subagent-{digest}"

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
        if item.type is HistoryItemType.CONTEXT_BASELINE_UPDATE:
            count = item.metadata.get("baseline_fragment_count", 0)
            hash_value = item.metadata.get("content_hash", "")
            return f"  inherited_context fragments={count} hash={hash_value}"
        if item.type is HistoryItemType.USER_MESSAGE and item.metadata.get("role") == "system":
            return f"  system {(item.text or '').replace(chr(10), ' ')[:500]}"
        return f"  user {(item.text or '').replace(chr(10), ' ')[:500]}"

    def _summary_for_child_unlocked(
        self,
        child_session_id: str,
    ) -> SubAgentRunSummary | None:
        for summary in self._recent_runs:
            if summary.child_session_id == child_session_id:
                return summary
        return None

    def _final_report_from_transcript(self, child_session_id: str) -> str:
        if self._session_service is None:
            return ""
        items = self._session_service.load_history_items(child_session_id)
        for item in reversed(items):
            if item.type is not HistoryItemType.ASSISTANT_MESSAGE:
                continue
            if isinstance(item.metadata.get("sub_agent_status"), str):
                return item.text or ""
        return ""

    def _output_report_from_summary(self, summary: SubAgentRunSummary) -> str:
        if summary.status == "running":
            return (
                f"Sub-agent {summary.agent_type} is still running. "
                f"{BACKGROUND_SUBAGENT_NOTIFICATION_GUIDANCE} "
                "Do not call SubagentOutput again unless the user explicitly asks "
                "for another progress check."
            )
        if summary.error:
            return summary.error
        return f"Sub-agent {summary.agent_type} finished with status {summary.status}."

    def _emit_completion_notification(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        *,
        completed_at: str,
    ) -> None:
        message = self._task_notification(invocation, result, completed_at=completed_at)
        steering: tuple[str, ...] = (message,)
        follow_up: tuple[str, ...] = ()
        if self._notification_sink is not None:
            with suppress(Exception):
                steering, follow_up = self._notification_sink(message)
        sink = self._stream_sink
        if sink is None:
            return
        try:
            sink(
                RuntimeStreamEvent(
                    kind="queue_updated",
                    metadata={"steering": list(steering), "follow_up": list(follow_up)},
                )
            )
        except Exception:
            return

    def _task_notification(
        self,
        invocation: SubAgentInvocation,
        result: SubAgentResult,
        *,
        completed_at: str,
    ) -> str:
        report = self._snapshot_report(result.report)
        summary = report.splitlines()[0].strip() if report.strip() else result.status
        return TaskNotification(
            task_id=result.child_session_id,
            task_type="local_agent",
            status=result.status,
            summary=summary,
            output_file=self._task_output_path(result.child_session_id),
            result=report,
            completed_at=completed_at,
            metadata={
                "agent": invocation.agent_type,
                "tool_calls": result.tool_calls,
            },
        ).to_xml()

    def _write_task_output(self, result: SubAgentResult) -> None:
        path = self._task_output_path(result.child_session_id)
        if path is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self._snapshot_report(result.report), encoding="utf-8")

    def _task_output_path(self, child_session_id: str) -> Path | None:
        if self._task_output_path_provider is None:
            return None
        with suppress(Exception):
            return self._task_output_path_provider(child_session_id)
        return None

    def _context_snapshot(self, tool_names: tuple[str, ...]) -> SubAgentContextSnapshot:
        baseline = self._context_baseline_provider()
        fragments, baseline_truncated = self._baseline_fragments(baseline)
        memory_fence, memory_truncated = self._bounded_text(
            self._memory_fence_provider(),
            limit=2000,
        )
        session_summary, session_truncated = self._bounded_text(
            self._session_summary_provider(),
            limit=2000,
        )
        content_parts = (*fragments, memory_fence, session_summary, *tool_names)
        content_hash = self._hash_parts(content_parts)
        diagnostics: dict[str, object] = {
            "baseline_fragment_count": len(fragments),
            "baseline_truncated": baseline_truncated,
            "memory_chars": len(memory_fence),
            "memory_truncated": memory_truncated,
            "session_summary_chars": len(session_summary),
            "session_summary_truncated": session_truncated,
            "tool_count": len(tool_names),
            "tool_names": list(tool_names),
            "content_hash": content_hash,
            "baseline_content_hash": self._hash_parts(fragments),
        }
        return SubAgentContextSnapshot(
            baseline_fragments=fragments,
            memory_fence=memory_fence,
            session_summary=session_summary,
            tool_names=tool_names,
            diagnostics=diagnostics,
        )

    def _trace_context_fork(
        self,
        invocation: SubAgentInvocation,
        child_session_id: str,
        snapshot: SubAgentContextSnapshot,
    ) -> None:
        if self._trace_service is None:
            return
        payload = {
            "child_session_id": child_session_id,
            "agent_type": invocation.agent_type,
            "mode": invocation.mode,
            **dict(snapshot.diagnostics),
        }
        self._trace_service.append(
            self._session_id,
            RuntimeTraceEvent(
                kind="subagent_context_fork",
                turn_id=invocation.parent_turn_id,
                payload=payload,
            ),
        )

    def _baseline_fragments(
        self,
        baseline: ContextBaseline | None,
        *,
        max_fragments: int = 6,
        max_chars_per_fragment: int = 1200,
    ) -> tuple[tuple[str, ...], bool]:
        if baseline is None:
            return (), False
        fragments: list[str] = []
        truncated = len(baseline.fragments) > max_fragments
        for fragment in baseline.fragments[:max_fragments]:
            content, was_truncated = self._bounded_text(
                fragment.content,
                limit=max_chars_per_fragment,
            )
            truncated = truncated or was_truncated
            if content:
                fragments.append(content)
        return tuple(fragments), truncated

    def _bounded_text(self, value: str, *, limit: int) -> tuple[str, bool]:
        text = value.strip()
        if len(text) <= limit:
            return text, False
        return text[:limit].rstrip() + "\n[truncated: inherited context exceeded limit]", True

    def _hash_parts(self, parts: tuple[str, ...]) -> str:
        digest = hashlib.sha256()
        for part in parts:
            if not part:
                continue
            digest.update(part.encode("utf-8", errors="replace"))
            digest.update(b"\0")
        return digest.hexdigest()[:16]

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

    def _snapshot_report(self, report: str) -> str:
        if not report.startswith("<sub-agent-report"):
            return report
        parser = _SubAgentReportTextParser()
        try:
            parser.feed(report)
            parser.close()
        except Exception:
            return report
        parsed = parser.text.strip()
        return parsed or report

    def _timestamp(self) -> str:
        return datetime.now(UTC).isoformat()


__all__ = ["SubAgentService"]


def _background_job_state(status: str) -> BackgroundJobState:
    if status == "running":
        return "running"
    if status == "cancelled":
        return "cancelled"
    if status == "completed":
        return "completed"
    if status == "failed":
        return "failed"
    return "unknown"


def _builtin_profile_lookup(profile_id: str) -> SubAgentProfile | None:
    from mycli.domain.subagent_profiles import get_sub_agent_profile

    return get_sub_agent_profile(profile_id)


class _SubAgentReportTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []

    @property
    def text(self) -> str:
        return "".join(self._parts)

    def handle_data(self, data: str) -> None:
        self._parts.append(data)

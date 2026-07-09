from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import TYPE_CHECKING, Protocol
from uuid import uuid4

from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.domain.subagents import SubAgentBudget, SubAgentInvocation, SubAgentProfile
from mycli.memory.memdir import format_memory_manifest, scan_memory_files
from mycli.memory.prompts import build_dream_consolidation_prompt

if TYPE_CHECKING:
    from mycli.application.runtime.subagents.loop import ChildTranscriptRecorder
    from mycli.domain.subagents import SubAgentContextSnapshot, SubAgentResult


MEMORY_DREAM_TOOLS = ("Read", "LS", "Write", "Edit", "Bash")
DEFAULT_MIN_HOURS = 24
DEFAULT_MIN_SESSIONS = 5
STAMP_NAME = ".dream-last-consolidated"


class SupportsTraceAppend(Protocol):
    def append(self, session_id: str, event: RuntimeTraceEvent) -> None: ...


class SupportsDreamChildLoop(Protocol):
    def run(
        self,
        *,
        invocation: SubAgentInvocation,
        profile: SubAgentProfile,
        child_session_id: str,
        tool_names: tuple[str, ...],
        context_snapshot: SubAgentContextSnapshot | None = None,
        transcript: ChildTranscriptRecorder | None = None,
    ) -> SubAgentResult: ...


@dataclass(slots=True, frozen=True)
class MemoryDreamRequest:
    session_id: str
    turn_id: str
    recent_session_ids: tuple[str, ...]
    now: datetime


class MemoryDreamService:
    def __init__(
        self,
        *,
        child_loop: SupportsDreamChildLoop,
        memory_dir: Path,
        trace_service: SupportsTraceAppend | None = None,
        executor: ThreadPoolExecutor | None = None,
        max_workers: int = 1,
        min_hours: int = DEFAULT_MIN_HOURS,
        min_sessions: int = DEFAULT_MIN_SESSIONS,
    ) -> None:
        self._child_loop = child_loop
        self._memory_dir = memory_dir
        self._trace_service = trace_service
        self._executor = executor or ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="mycli-memory-dream",
        )
        self._owns_executor = executor is None
        self._min_hours = min_hours
        self._min_sessions = min_sessions
        self._lock = Lock()
        self._in_progress = False

    def maybe_start_background_dream(
        self,
        request: MemoryDreamRequest,
    ) -> tuple[str, ...]:
        if not scan_memory_files(self._memory_dir):
            self._trace(request, result="skipped_no_memories")
            return ()
        last_at = self.last_consolidated_at()
        if last_at is None:
            last_at = request.now - timedelta(hours=self._min_hours + 1)
        if request.now - last_at < timedelta(hours=self._min_hours):
            self._trace(request, result="skipped_time_gate")
            return ()
        recent = tuple(
            session_id
            for session_id in request.recent_session_ids
            if session_id != request.session_id
        )
        if len(recent) < self._min_sessions:
            self._trace(request, result="skipped_session_gate", session_count=len(recent))
            return ()
        with self._lock:
            if self._in_progress:
                self._trace(request, result="skipped_in_progress", session_count=len(recent))
                return ()
            self._in_progress = True
        self._executor.submit(self._run_background, request, recent)
        self._trace(request, result="started", session_count=len(recent))
        return ("memory_dream_started",)

    def shutdown(self) -> None:
        if self._owns_executor:
            self._executor.shutdown(wait=False)

    def last_consolidated_at(self) -> datetime | None:
        try:
            raw = self._stamp_path().read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return None
        except OSError:
            return None
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)

    def record_consolidation(self, when: datetime) -> None:
        self._memory_dir.mkdir(parents=True, exist_ok=True)
        normalized = when if when.tzinfo is not None else when.replace(tzinfo=UTC)
        self._stamp_path().write_text(
            normalized.astimezone(UTC).isoformat(),
            encoding="utf-8",
        )

    def _run_background(
        self,
        request: MemoryDreamRequest,
        recent_session_ids: tuple[str, ...],
    ) -> None:
        try:
            result = self._run_agent(request, recent_session_ids)
            if result.status in {"completed", "max_turns", "max_tool_calls"}:
                self.record_consolidation(request.now)
            self._trace(
                request,
                result=result.status,
                tool_calls=result.tool_calls,
                child_session_id=result.child_session_id,
                session_count=len(recent_session_ids),
            )
        except Exception as exc:
            self._trace(
                request,
                result="failed",
                error_kind=type(exc).__name__,
                session_count=len(recent_session_ids),
            )
        finally:
            with self._lock:
                self._in_progress = False

    def _run_agent(
        self,
        request: MemoryDreamRequest,
        recent_session_ids: tuple[str, ...],
    ) -> SubAgentResult:
        child_session_id = f"{request.session_id}:dream:{request.turn_id}:{uuid4().hex[:8]}"
        invocation = SubAgentInvocation(
            agent_type="dream",
            description=self._prompt(recent_session_ids),
            allowed_tools=MEMORY_DREAM_TOOLS,
            parent_session_id=request.session_id,
            parent_turn_id=request.turn_id,
            mode="background",
        )
        return self._child_loop.run(
            invocation=invocation,
            profile=self._profile(),
            child_session_id=child_session_id,
            tool_names=MEMORY_DREAM_TOOLS,
            context_snapshot=None,
            transcript=None,
        )

    def _prompt(self, recent_session_ids: tuple[str, ...]) -> str:
        existing = format_memory_manifest(scan_memory_files(self._memory_dir))
        return build_dream_consolidation_prompt(
            memory_dir=str(self._memory_dir),
            existing_memories=existing,
            recent_session_ids=recent_session_ids,
        )

    def _profile(self) -> SubAgentProfile:
        return SubAgentProfile(
            name="dream",
            system_prompt=(
                "You are an internal memory consolidation agent. Consolidate persistent memory. "
                "Do not answer the user. Do not modify project files outside the memory directory."
            ),
            default_tools=MEMORY_DREAM_TOOLS,
            denied_tools=("Task", "AskUserQuestion", "WebSearch", "WebFetch"),
            budget=SubAgentBudget(max_turns=8, max_tool_calls=20, no_progress_turn_limit=3),
        )

    def _stamp_path(self) -> Path:
        return self._memory_dir / STAMP_NAME

    def _trace(
        self,
        request: MemoryDreamRequest,
        *,
        result: str,
        tool_calls: int = 0,
        child_session_id: str | None = None,
        session_count: int = 0,
        error_kind: str | None = None,
    ) -> None:
        if self._trace_service is None:
            return
        payload: dict[str, object] = {
            "mode": "background_agent",
            "result": result,
            "tool_calls": tool_calls,
            "session_count": session_count,
        }
        if child_session_id:
            payload["child_session_id"] = child_session_id
        if error_kind:
            payload["error_kind"] = error_kind
        self._trace_service.append(
            request.session_id,
            RuntimeTraceEvent(
                kind="memory_dream",
                turn_id=request.turn_id,
                payload=payload,
            ),
        )

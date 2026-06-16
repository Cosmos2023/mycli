from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import TYPE_CHECKING, Protocol
from uuid import uuid4

from mycli.domain.runtime import TurnItem, TurnItemType
from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.domain.subagents import SubAgentBudget, SubAgentInvocation, SubAgentProfile
from mycli.memory.extraction import extract_explicit_memory_request
from mycli.memory.memdir import format_memory_manifest, scan_memory_files
from mycli.memory.prompts import build_extract_auto_only_prompt
from mycli.memory.service import MemoryService

if TYPE_CHECKING:
    from mycli.application.runtime.subagents.loop import ChildTranscriptRecorder
    from mycli.domain.subagents import SubAgentContextSnapshot, SubAgentResult


MEMORY_EXTRACTION_TOOLS = ("Read", "Grep", "Glob", "LS", "Write", "Edit")


class SupportsTraceAppend(Protocol):
    def append(self, session_id: str, event: RuntimeTraceEvent) -> None: ...


class SupportsMemoryChildLoop(Protocol):
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
class MemoryExtractionRequest:
    session_id: str
    turn_id: str
    user_message: str
    assistant_message: str
    turn_items: tuple[TurnItem, ...]


class MemoryExtractionService:
    def __init__(
        self,
        *,
        memory_service: MemoryService,
        child_loop: SupportsMemoryChildLoop,
        memory_dir: Path,
        trace_service: SupportsTraceAppend | None = None,
        executor: ThreadPoolExecutor | None = None,
        max_workers: int = 1,
    ) -> None:
        self._memory_service = memory_service
        self._child_loop = child_loop
        self._memory_dir = memory_dir
        self._trace_service = trace_service
        self._executor = executor or ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="mycli-memory-extract",
        )
        self._owns_executor = executor is None
        self._lock = Lock()
        self._in_progress = False

    def maybe_start_background_extraction(
        self,
        request: MemoryExtractionRequest,
    ) -> tuple[str, ...]:
        if self._has_memory_write(request.turn_items):
            self._trace(request, result="skipped_direct_write")
            return ("memory_extract_skipped:direct_write",)
        with self._lock:
            if self._in_progress:
                self._trace(request, result="skipped_in_progress")
                return ("memory_extract_skipped:in_progress",)
            self._in_progress = True
        self._executor.submit(self._run_background, request)
        self._trace(request, result="started")
        return ("memory_extract_started",)

    def shutdown(self) -> None:
        if self._owns_executor:
            self._executor.shutdown(wait=False)

    def _run_background(self, request: MemoryExtractionRequest) -> None:
        try:
            result = self._run_agent(request)
            if result.status in {"completed", "max_turns", "max_tool_calls"}:
                self._trace(
                    request,
                    result=result.status,
                    tool_calls=result.tool_calls,
                    child_session_id=result.child_session_id,
                )
            else:
                fallback_updates = self._fallback_explicit_extraction(request.user_message)
                self._trace(
                    request,
                    result=f"fallback_after_{result.status}",
                    tool_calls=result.tool_calls,
                    child_session_id=result.child_session_id,
                    updates=fallback_updates,
                )
        except Exception as exc:
            fallback_updates = self._fallback_explicit_extraction(request.user_message)
            self._trace(
                request,
                result="failed_fallback",
                error_kind=type(exc).__name__,
                updates=fallback_updates,
            )
        finally:
            with self._lock:
                self._in_progress = False

    def _run_agent(self, request: MemoryExtractionRequest) -> SubAgentResult:
        child_session_id = f"{request.session_id}:memory:{request.turn_id}:{uuid4().hex[:8]}"
        invocation = SubAgentInvocation(
            agent_type="extract_memories",
            description=self._prompt(request),
            allowed_tools=MEMORY_EXTRACTION_TOOLS,
            parent_session_id=request.session_id,
            parent_turn_id=request.turn_id,
            mode="background",
        )
        return self._child_loop.run(
            invocation=invocation,
            profile=self._profile(),
            child_session_id=child_session_id,
            tool_names=MEMORY_EXTRACTION_TOOLS,
            context_snapshot=None,
            transcript=None,
        )

    def _prompt(self, request: MemoryExtractionRequest) -> str:
        existing = format_memory_manifest(scan_memory_files(self._memory_dir))
        extraction_prompt = build_extract_auto_only_prompt(
            new_message_count=2,
            existing_memories=existing,
            memory_dir=str(self._memory_dir),
        )
        return "\n".join(
            [
                extraction_prompt,
                "",
                "- If nothing should be saved, reply exactly: No memory updates.",
                "",
                "Latest user message:",
                request.user_message,
                "",
                "Latest assistant response:",
                request.assistant_message,
            ]
        )

    def _profile(self) -> SubAgentProfile:
        return SubAgentProfile(
            name="extract_memories",
            system_prompt=(
                "You are an internal memory extraction agent. Maintain the file-based memory system. "
                "Be selective. Do not answer the user. Do not modify project files."
            ),
            default_tools=MEMORY_EXTRACTION_TOOLS,
            denied_tools=("Task", "AskUserQuestion", "Bash", "WebSearch", "WebFetch"),
            budget=SubAgentBudget(max_turns=5, max_tool_calls=8, no_progress_turn_limit=2),
        )

    def _fallback_explicit_extraction(self, user_message: str) -> tuple[str, ...]:
        if extract_explicit_memory_request(user_message) is None:
            return ()
        return self._memory_service.extract_explicit_memory(user_message)

    def _has_memory_write(self, turn_items: tuple[TurnItem, ...]) -> bool:
        memory_root = self._memory_dir.resolve()
        for item in turn_items:
            if item.type is not TurnItemType.TOOL_CALL:
                continue
            if item.tool_name not in {"Write", "Edit", "Patch"}:
                continue
            arguments = item.metadata.get("arguments")
            if not isinstance(arguments, dict):
                continue
            raw_path = arguments.get("file_path") or arguments.get("path")
            if not isinstance(raw_path, str) or not raw_path:
                continue
            candidate = Path(raw_path)
            resolved = (candidate if candidate.is_absolute() else memory_root / candidate).resolve()
            if resolved == memory_root or memory_root in resolved.parents:
                return True
        return False

    def _trace(
        self,
        request: MemoryExtractionRequest,
        *,
        result: str,
        tool_calls: int = 0,
        child_session_id: str | None = None,
        updates: tuple[str, ...] = (),
        error_kind: str | None = None,
    ) -> None:
        if self._trace_service is None:
            return
        payload: dict[str, object] = {
            "mode": "background_agent",
            "result": result,
            "tool_calls": tool_calls,
            "update_count": len(updates),
        }
        if updates:
            payload["updates"] = updates
        if child_session_id:
            payload["child_session_id"] = child_session_id
        if error_kind:
            payload["error_kind"] = error_kind
        self._trace_service.append(
            request.session_id,
            RuntimeTraceEvent(
                kind="memory_extraction",
                turn_id=request.turn_id,
                payload=payload,
            ),
        )

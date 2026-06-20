from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mycli.domain.runtime import TurnItem, TurnItemType
from mycli.domain.subagents import SubAgentInvocation, SubAgentProfile
from mycli.memory.extraction_service import (
    MEMORY_EXTRACTION_TOOLS,
    MemoryExtractionRequest,
    MemoryExtractionService,
)
from mycli.memory.service import MemoryService


@dataclass(slots=True)
class FakeChildResult:
    status: str = "failed"
    tool_calls: int = 0
    child_session_id: str = "child"


class FakeChildLoop:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def run(
        self,
        *,
        invocation: SubAgentInvocation,
        profile: SubAgentProfile,
        child_session_id: str,
        tool_names: tuple[str, ...],
        context_snapshot: object | None = None,
        transcript: object | None = None,
    ) -> FakeChildResult:
        self.calls.append(
            {
                "invocation": invocation,
                "profile": profile,
                "child_session_id": child_session_id,
                "tool_names": tool_names,
                "context_snapshot": context_snapshot,
                "transcript": transcript,
            }
        )
        return FakeChildResult(child_session_id=child_session_id)


class ImmediateExecutor:
    def submit(self, fn, *args, **kwargs):  # type: ignore[no-untyped-def]
        fn(*args, **kwargs)


def test_memory_extraction_service_runs_background_agent_with_memory_tool_scope(
    tmp_path: Path,
) -> None:
    memory_service = MemoryService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    child_loop = FakeChildLoop()
    service = MemoryExtractionService(
        memory_service=memory_service,
        child_loop=child_loop,
        memory_dir=memory_service.file_memory_dir(),
        executor=ImmediateExecutor(),  # type: ignore[arg-type]
    )

    updates = service.maybe_start_background_extraction(
        MemoryExtractionRequest(
            session_id="demo",
            turn_id="turn_1",
            user_message="remember that I prefer terse final answers",
            assistant_message="Got it.",
            turn_items=(),
        )
    )

    assert updates == ("memory_extract_started",)
    assert child_loop.calls
    call = child_loop.calls[0]
    assert call["tool_names"] == MEMORY_EXTRACTION_TOOLS
    assert call["transcript"] is None
    assert "Memory directory:" in call["invocation"].description
    assert "add a pointer to that file in `MEMORY.md`" in call["invocation"].description
    assert (memory_service.file_memory_dir() / "i_prefer_terse_final_answers.md").exists()


def test_memory_extraction_service_throttles_automatic_extraction(
    tmp_path: Path,
) -> None:
    memory_service = MemoryService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    child_loop = FakeChildLoop()
    service = MemoryExtractionService(
        memory_service=memory_service,
        child_loop=child_loop,
        memory_dir=memory_service.file_memory_dir(),
        executor=ImmediateExecutor(),  # type: ignore[arg-type]
        automatic_interval_turns=3,
    )

    first = service.maybe_start_background_extraction(
        MemoryExtractionRequest(
            session_id="demo",
            turn_id="turn_1",
            user_message="continue",
            assistant_message="Done.",
            turn_items=(),
        )
    )
    second = service.maybe_start_background_extraction(
        MemoryExtractionRequest(
            session_id="demo",
            turn_id="turn_2",
            user_message="keep going",
            assistant_message="Done.",
            turn_items=(),
        )
    )
    third = service.maybe_start_background_extraction(
        MemoryExtractionRequest(
            session_id="demo",
            turn_id="turn_3",
            user_message="next",
            assistant_message="Done.",
            turn_items=(),
        )
    )

    assert first == ("memory_extract_skipped:interval",)
    assert second == ("memory_extract_skipped:interval",)
    assert third == ("memory_extract_started",)
    assert len(child_loop.calls) == 1


def test_memory_extraction_service_runs_explicit_memory_without_interval_wait(
    tmp_path: Path,
) -> None:
    memory_service = MemoryService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    child_loop = FakeChildLoop()
    service = MemoryExtractionService(
        memory_service=memory_service,
        child_loop=child_loop,
        memory_dir=memory_service.file_memory_dir(),
        executor=ImmediateExecutor(),  # type: ignore[arg-type]
        automatic_interval_turns=10,
    )

    updates = service.maybe_start_background_extraction(
        MemoryExtractionRequest(
            session_id="demo",
            turn_id="turn_1",
            user_message="remember that I prefer terse final answers",
            assistant_message="Got it.",
            turn_items=(),
        )
    )

    assert updates == ("memory_extract_started",)
    assert child_loop.calls


def test_memory_extraction_service_disables_extraction_with_negative_interval(
    tmp_path: Path,
) -> None:
    memory_service = MemoryService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    child_loop = FakeChildLoop()
    service = MemoryExtractionService(
        memory_service=memory_service,
        child_loop=child_loop,
        memory_dir=memory_service.file_memory_dir(),
        executor=ImmediateExecutor(),  # type: ignore[arg-type]
        automatic_interval_turns=-1,
    )

    updates = service.maybe_start_background_extraction(
        MemoryExtractionRequest(
            session_id="demo",
            turn_id="turn_1",
            user_message="remember that I prefer terse final answers",
            assistant_message="Got it.",
            turn_items=(),
        )
    )

    assert updates == ("memory_extract_skipped:disabled",)
    assert child_loop.calls == []


def test_memory_extraction_service_skips_when_main_agent_wrote_memory(
    tmp_path: Path,
) -> None:
    memory_service = MemoryService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    child_loop = FakeChildLoop()
    service = MemoryExtractionService(
        memory_service=memory_service,
        child_loop=child_loop,
        memory_dir=memory_service.file_memory_dir(),
        executor=ImmediateExecutor(),  # type: ignore[arg-type]
    )
    memory_file = memory_service.file_memory_dir() / "tone.md"

    updates = service.maybe_start_background_extraction(
        MemoryExtractionRequest(
            session_id="demo",
            turn_id="turn_1",
            user_message="remember that I prefer terse final answers",
            assistant_message="Done.",
            turn_items=(
                TurnItem(
                    type=TurnItemType.TOOL_CALL,
                    tool_name="Write",
                    metadata={"arguments": {"file_path": str(memory_file)}},
                ),
            ),
        )
    )

    assert updates == ("memory_extract_skipped:direct_write",)
    assert child_loop.calls == []

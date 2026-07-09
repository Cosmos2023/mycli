from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

from mycli.domain.memory import MemoryKind
from mycli.domain.subagents import SubAgentInvocation, SubAgentProfile
from mycli.memory.dream_service import MemoryDreamRequest, MemoryDreamService
from mycli.memory.service import MemoryService


@dataclass(slots=True)
class FakeChildResult:
    status: str = "completed"
    tool_calls: int = 2
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


def test_memory_dream_service_skips_until_time_and_session_thresholds(
    tmp_path: Path,
) -> None:
    memory_service = MemoryService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    memory_service.add_file_memory(
        kind=MemoryKind.USER,
        name="reply style",
        description="User wants concise replies",
        content="Keep final replies concise.",
    )
    child_loop = FakeChildLoop()
    service = MemoryDreamService(
        child_loop=cast(Any, child_loop),
        memory_dir=memory_service.file_memory_dir(),
        executor=ImmediateExecutor(),  # type: ignore[arg-type]
        min_hours=24,
        min_sessions=2,
    )
    service.record_consolidation(datetime.now(UTC))

    updates = service.maybe_start_background_dream(
        MemoryDreamRequest(
            session_id="current",
            turn_id="turn_1",
            recent_session_ids=("older",),
            now=datetime.now(UTC),
        )
    )

    assert updates == ()
    assert child_loop.calls == []


def test_memory_dream_service_runs_consolidation_agent_when_due(
    tmp_path: Path,
) -> None:
    memory_service = MemoryService(home_dir=tmp_path / "home", workspace_root=tmp_path)
    memory_service.add_file_memory(
        kind=MemoryKind.USER,
        name="reply style",
        description="User wants concise replies",
        content="Keep final replies concise.",
    )
    child_loop = FakeChildLoop()
    service = MemoryDreamService(
        child_loop=cast(Any, child_loop),
        memory_dir=memory_service.file_memory_dir(),
        executor=ImmediateExecutor(),  # type: ignore[arg-type]
        min_hours=24,
        min_sessions=2,
    )
    old_stamp = datetime.now(UTC) - timedelta(hours=25)
    service.record_consolidation(old_stamp)

    updates = service.maybe_start_background_dream(
        MemoryDreamRequest(
            session_id="current",
            turn_id="turn_2",
            recent_session_ids=("a", "b"),
            now=datetime.now(UTC),
        )
    )

    assert updates == ("memory_dream_started",)
    assert child_loop.calls
    call = child_loop.calls[0]
    assert call["transcript"] is None
    assert call["tool_names"] == ("Read", "LS", "Write", "Edit", "Bash")
    invocation = call["invocation"]
    assert invocation.agent_type == "dream"
    assert invocation.mode == "background"
    assert "Dream: Memory Consolidation" in invocation.description
    assert "Sessions since last consolidation (2):" in invocation.description
    assert "- a" in invocation.description
    assert "reply_style.md" in invocation.description
    assert service.last_consolidated_at() is not None

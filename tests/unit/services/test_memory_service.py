from pathlib import Path

from mycli.domain.memory import MemoryKind
from mycli.memory.memdir import FileMemory
from mycli.memory.memdir import ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES
from mycli.memory.service import MemoryService


class FilenameSelector:
    def __init__(self, filenames: tuple[str, ...]) -> None:
        self.filenames = filenames
        self.calls: list[tuple[str, tuple[str, ...], int]] = []

    def select(
        self,
        query: str,
        memories: tuple[FileMemory, ...],
        *,
        limit: int,
    ) -> tuple[str, ...]:
        self.calls.append((query, tuple(memory.filename for memory in memories), limit))
        return self.filenames


def test_memory_service_rehydrates_session_summaries_into_runtime_context(
    tmp_path: Path,
) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.append_session_summary("demo", "Assistant answer from the previous turn")

    records = service.collect_runtime_context(
        user_message="continue",
        session_id="demo",
    )

    assert [record.kind for record in records] == [
        MemoryKind.REFERENCE,
        MemoryKind.SESSION_SUMMARY,
    ]
    assert records[-1].value == "Assistant answer from the previous turn"


def test_memory_service_creates_claude_style_memory_directory(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )

    memory_dir = service.file_memory_dir()

    assert memory_dir.exists()
    assert memory_dir.name == "memory"
    assert service.file_memory_entrypoint_path() == memory_dir / ENTRYPOINT_NAME


def test_memory_service_adds_file_memory_and_updates_entrypoint(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )

    memory = service.add_file_memory(
        kind=MemoryKind.FEEDBACK,
        name="terse replies",
        description="User prefers concise final responses",
        content="Keep final replies short unless the user asks for detail.",
    )

    assert memory.filename == "terse_replies.md"
    raw = memory.path.read_text(encoding="utf-8")
    assert "type: feedback" in raw
    assert "description: User prefers concise final responses" in raw
    entrypoint = service.file_memory_entrypoint_path().read_text(encoding="utf-8")
    assert "- [terse replies](terse_replies.md)" in entrypoint


def test_memory_service_searches_file_memories_by_header_and_body(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.add_file_memory(
        kind=MemoryKind.PROJECT,
        name="release freeze",
        description="Mobile release freeze timing",
        content="Merge freeze starts on 2026-06-20 for mobile release work.",
    )
    service.add_file_memory(
        kind=MemoryKind.REFERENCE,
        name="unrelated dashboard",
        description="Grafana dashboard pointer",
        content="Latency dashboard lives elsewhere.",
    )

    matches = service.search_file_memories("mobile freeze", limit=1)

    assert [memory.filename for memory in matches] == ["release_freeze.md"]


def test_memory_service_runtime_context_includes_entrypoint_and_relevant_file_memory(
    tmp_path: Path,
) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.add_file_memory(
        kind=MemoryKind.USER,
        name="frontend background",
        description="User has strong frontend experience",
        content="User has built React apps for years; skip basic component explanations.",
    )

    records = service.collect_runtime_context(
        user_message="explain frontend rendering",
        session_id="demo",
    )

    assert any(record.key == ENTRYPOINT_NAME for record in records)
    assert any(record.key == "frontend_background.md" for record in records)
    assert any("persistent file-based memory" in record.value for record in records)


def test_memory_service_can_disable_runtime_file_memory(
    tmp_path: Path,
) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.add_file_memory(
        kind=MemoryKind.USER,
        name="frontend background",
        description="User has strong frontend experience",
        content="User has built React apps for years.",
    )

    records = service.collect_runtime_context(
        user_message="explain frontend rendering",
        session_id="demo",
        enabled=False,
    )

    assert records == ()


def test_memory_service_uses_selector_manifest_to_pick_runtime_file_memories(
    tmp_path: Path,
) -> None:
    selector = FilenameSelector(("stable_preferences.md",))
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
        file_memory_selector=selector,
    )
    service.add_file_memory(
        kind=MemoryKind.USER,
        name="stable preferences",
        description="User wants concise output",
        content="Keep final replies concise.",
    )
    service.add_file_memory(
        kind=MemoryKind.PROJECT,
        name="unrelated database",
        description="Database migration schedule",
        content="Database migration starts later.",
    )

    records = service.collect_runtime_context(
        user_message="what should I know before replying?",
        session_id="demo",
    )

    assert selector.calls == [
        (
            "what should I know before replying?",
            ("unrelated_database.md", "stable_preferences.md"),
            5,
        )
    ]
    assert any(record.key == "stable_preferences.md" for record in records)
    assert all(record.key != "unrelated_database.md" for record in records)


def test_memory_service_can_ignore_file_memory_for_current_turn(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.add_file_memory(
        kind=MemoryKind.USER,
        name="frontend background",
        description="User has strong frontend experience",
        content="User has built React apps for years.",
    )

    records = service.collect_runtime_context(
        user_message="ignore memory and explain frontend rendering",
        session_id="demo",
    )

    assert all("frontend_background.md" not in record.key for record in records)
    assert all("persistent file-based memory" not in record.value for record in records)


def test_memory_service_forgets_file_memory_and_entrypoint_line(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.add_file_memory(
        kind=MemoryKind.FEEDBACK,
        name="terse replies",
        description="User prefers concise final responses",
        content="Keep final replies short.",
    )

    removed = service.forget_file_memory("terse_replies.md")

    assert [memory.filename for memory in removed] == ["terse_replies.md"]
    assert not (service.file_memory_dir() / "terse_replies.md").exists()
    assert "terse_replies.md" not in service.file_memory_entrypoint_path().read_text(
        encoding="utf-8"
    )


def test_memory_service_truncates_long_memory_entrypoint(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.file_memory_entrypoint_path().write_text(
        "\n".join(f"- item {index}" for index in range(MAX_ENTRYPOINT_LINES + 2)),
        encoding="utf-8",
    )

    records = service.collect_runtime_context(
        user_message="remember project context",
        session_id="demo",
    )
    entrypoint = next(record for record in records if record.key == ENTRYPOINT_NAME)

    assert "WARNING: MEMORY.md" in entrypoint.value


def test_memory_service_extracts_explicit_remember_request(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )

    updates = service.extract_explicit_memory(
        "remember that I prefer terse final answers"
    )

    assert updates == ("memory_saved:i_prefer_terse_final_answers.md",)
    assert (service.file_memory_dir() / "i_prefer_terse_final_answers.md").exists()
    assert "i_prefer_terse_final_answers.md" in service.file_memory_entrypoint_path().read_text(
        encoding="utf-8"
    )


def test_memory_service_extracts_explicit_forget_request(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.extract_explicit_memory("remember that I prefer terse final answers")

    updates = service.extract_explicit_memory("forget terse final answers")

    assert updates == ("memory_forgot:i_prefer_terse_final_answers.md",)
    assert not (service.file_memory_dir() / "i_prefer_terse_final_answers.md").exists()

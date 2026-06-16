from pathlib import Path

from mycli.domain.memory import MemoryKind, MemoryRecord
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


def test_memory_service_round_trips_preferences_and_project_notes(tmp_path: Path) -> None:
    service = MemoryService(home_dir=tmp_path / "home", workspace_root=tmp_path / "workspace")

    service.save_preference("tone", "concise")
    service.save_project_note(
        MemoryRecord(kind=MemoryKind.PROJECT_NOTE, key="entrypoint", value="src/mycli/cli/main.py")
    )
    service.append_session_summary("demo", "Inspected the repo root")

    assert service.load_preferences()["tone"] == "concise"
    notes = service.search_project_notes("entry")
    assert notes[0].value == "src/mycli/cli/main.py"
    assert service.load_session_summaries("demo") == ["Inspected the repo root"]
    assert (tmp_path / "home" / ".mycli" / "sessions.db").exists()
    assert not (tmp_path / "home" / ".mycli" / "sessions" / "demo-summary.json").exists()


def test_memory_service_queries_records_across_scopes(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )

    service.save_preference("tone", "concise")
    service.save_project_note(
        MemoryRecord(
            kind=MemoryKind.PROJECT_NOTE,
            key="entrypoint",
            value="src/mycli/cli/main.py",
            tags=("repo",),
        )
    )
    service.append_session_summary("demo", "Inspected the repo root")

    records = service.query_records("repo", session_id="demo")

    assert [record.kind for record in records] == [
        MemoryKind.PROJECT_NOTE,
        MemoryKind.SESSION_SUMMARY,
    ]
    assert records[0].value == "src/mycli/cli/main.py"


def test_memory_service_rehydrates_session_summaries_into_runtime_context(
    tmp_path: Path,
) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.save_preference("tone", "concise")
    service.append_session_summary("demo", "Assistant answer from the previous turn")

    records = service.collect_runtime_context(
        user_message="continue",
        session_id="demo",
    )

    assert [record.kind for record in records] == [
        MemoryKind.PREFERENCE,
        MemoryKind.REFERENCE,
        MemoryKind.SESSION_SUMMARY,
    ]
    assert records[-1].value == "Assistant answer from the previous turn"


def test_memory_service_ranks_lexical_matches_beyond_substrings(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.save_project_note(
        MemoryRecord(
            kind=MemoryKind.PROJECT_NOTE,
            key="cache diagnostics",
            value="DeepSeek cache evidence lives in request shape metrics.",
            tags=("provider", "telemetry"),
        )
    )
    service.save_project_note(
        MemoryRecord(
            kind=MemoryKind.PROJECT_NOTE,
            key="unrelated",
            value="The CLI entry point is src/mycli/cli/main.py.",
        )
    )

    records = service.query_records("deepseek provider telemetry", limit=1)

    assert [record.key for record in records] == ["cache diagnostics"]


def test_memory_service_deduplicates_memories_across_tiers(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    duplicate = MemoryRecord(
        kind=MemoryKind.PROJECT_NOTE,
        key="entrypoint",
        value="src/mycli/cli/main.py",
        tags=("repo",),
    )
    service.save_project_note(duplicate)
    service.remember_transient("demo", duplicate)
    service.remember_short_term("demo", duplicate)

    records = service.query_records("entrypoint repo", session_id="demo")

    assert records == (duplicate,)


def test_memory_service_persists_short_term_records_across_instances(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace_root = tmp_path / "workspace"
    service = MemoryService(home_dir=home_dir, workspace_root=workspace_root)
    service.remember_short_term(
        "demo",
        MemoryRecord(
            kind=MemoryKind.SESSION_SUMMARY,
            key="plan",
            value="Phase 4 memory upgrade uses stdlib lexical scoring.",
            tags=("phase4",),
        ),
    )

    restored = MemoryService(home_dir=home_dir, workspace_root=workspace_root)

    assert restored.query_records("lexical phase4", session_id="demo") == (
        MemoryRecord(
            kind=MemoryKind.SESSION_SUMMARY,
            key="plan",
            value="Phase 4 memory upgrade uses stdlib lexical scoring.",
            tags=("phase4",),
        ),
    )


def test_memory_service_keeps_transient_records_session_local(tmp_path: Path) -> None:
    service = MemoryService(
        home_dir=tmp_path / "home",
        workspace_root=tmp_path / "workspace",
    )
    service.remember_transient(
        "demo",
        MemoryRecord(
            kind=MemoryKind.PROJECT_NOTE,
            key="scratch",
            value="Current turn inspected memory service internals.",
        ),
    )

    assert service.query_records("scratch", session_id="demo")
    assert service.query_records("scratch", session_id="other") == ()


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
    service.save_preference("tone", "concise")

    records = service.collect_runtime_context(
        user_message="explain frontend rendering",
        session_id="demo",
        enabled=False,
    )

    assert [record.kind for record in records] == [MemoryKind.PREFERENCE]
    assert all("frontend_background.md" not in record.key for record in records)
    assert all("persistent file-based memory" not in record.value for record in records)


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

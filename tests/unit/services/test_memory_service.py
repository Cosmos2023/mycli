from pathlib import Path

from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.memory.service import MemoryService


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

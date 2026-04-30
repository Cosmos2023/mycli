from pathlib import Path

from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.services.memory_service import MemoryService


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


def test_memory_service_does_not_auto_inject_session_summaries_into_runtime_context(
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

    assert [record.kind for record in records] == [MemoryKind.PREFERENCE]
    assert "Assistant answer from the previous turn" not in {
        record.value for record in records
    }

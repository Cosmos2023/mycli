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

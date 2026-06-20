from pathlib import Path

import pytest

from mycli.services.storage_layout import MycliStorageLayout


def test_storage_layout_separates_session_snapshot_and_trace_paths(tmp_path: Path) -> None:
    layout = MycliStorageLayout.from_home_dir(tmp_path)

    assert layout.sessions_db_path == tmp_path / ".mycli" / "sessions.db"
    assert layout.session_snapshot_path("session-id") == (
        tmp_path / ".mycli" / "sessions" / "session-id" / "session.json"
    )
    assert layout.session_events_path("session-id") == (
        tmp_path / ".mycli" / "sessions" / "session-id" / "events.jsonl"
    )
    assert layout.trace_path("session-id") == (
        tmp_path / ".mycli" / "traces" / "session-id-trace.jsonl"
    )
    assert layout.legacy_trace_path("session-id") == (
        tmp_path / ".mycli" / "sessions" / "session-id-trace.jsonl"
    )
    assert layout.vendor_dir == tmp_path / ".mycli" / "vendor"


@pytest.mark.parametrize("session_id", ["", "<session>", "../escape", "a/b", "a\\b"])
def test_storage_layout_rejects_unsafe_session_ids(
    tmp_path: Path,
    session_id: str,
) -> None:
    layout = MycliStorageLayout.from_home_dir(tmp_path)

    with pytest.raises(ValueError, match="invalid storage session id"):
        layout.session_snapshot_path(session_id)

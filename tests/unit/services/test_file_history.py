from __future__ import annotations

import json

from mycli.services.file_history import FileHistoryService


def test_file_history_rewinds_existing_file(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    path = workspace / "notes.txt"
    path.write_text("before\n", encoding="utf-8")
    service = FileHistoryService(home_dir=home, workspace_root=workspace)

    snapshot = service.snapshot_path(
        session_id="demo",
        turn_id="turn_1",
        raw_path="notes.txt",
        tool_name="edit_file",
    )
    path.write_text("after\n", encoding="utf-8")

    result = service.rewind_latest(session_id="demo")

    assert result.restored_paths == ("notes.txt",)
    assert result.deleted_paths == ()
    assert result.snapshot_id == snapshot.snapshot_id
    assert path.read_text(encoding="utf-8") == "before\n"


def test_file_history_manifest_records_three_layer_change_detection(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    path = workspace / "notes.txt"
    path.write_text("before\n", encoding="utf-8")
    service = FileHistoryService(home_dir=home, workspace_root=workspace)

    snapshot = service.snapshot_path(
        session_id="demo",
        turn_id="turn_1",
        raw_path="notes.txt",
        tool_name="edit_file",
    )

    manifest_path = (
        home
        / ".mycli"
        / "file-history"
        / "demo"
        / snapshot.snapshot_id
        / "manifest.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    detection = manifest["entries"][0]["change_detection"]
    assert detection["exists"] is True
    assert detection["size"] == len("before\n")
    assert isinstance(detection["mtime_ns"], int)
    assert isinstance(detection["sha256"], str)


def test_file_history_lists_recent_snapshots_with_paths(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("before\n", encoding="utf-8")
    service = FileHistoryService(home_dir=home, workspace_root=workspace)

    snapshot = service.snapshot_path(
        session_id="demo",
        turn_id="turn_1",
        raw_path="notes.txt",
        tool_name="Edit",
    )

    rows = service.list_snapshots(session_id="demo", limit=5)

    assert rows == (
        {
            "snapshot_id": snapshot.snapshot_id,
            "turn_id": "turn_1",
            "tool_name": "Edit",
            "paths": ("notes.txt",),
        },
    )


def test_file_history_rewinds_created_file_by_deleting_it(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    service = FileHistoryService(home_dir=home, workspace_root=workspace)

    service.snapshot_path(
        session_id="demo",
        turn_id="turn_1",
        raw_path="created.txt",
        tool_name="create_file",
    )
    (workspace / "created.txt").write_text("new\n", encoding="utf-8")

    result = service.rewind_latest(session_id="demo")

    assert result.restored_paths == ()
    assert result.deleted_paths == ("created.txt",)
    assert not (workspace / "created.txt").exists()


def test_file_history_rejects_workspace_escape(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    service = FileHistoryService(home_dir=home, workspace_root=workspace)

    result = service.snapshot_path(
        session_id="demo",
        turn_id="turn_1",
        raw_path="../outside.txt",
        tool_name="edit_file",
    )

    assert result.snapshot_id == ""
    assert result.error is not None
    assert "workspace" in result.error.lower()

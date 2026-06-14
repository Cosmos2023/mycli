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


def test_file_history_manifest_jsonl_records_three_layer_change_detection(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    path = workspace / "notes.txt"
    path.write_text("before\n", encoding="utf-8")
    service = FileHistoryService(home_dir=home, workspace_root=workspace)

    service.snapshot_path(
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
        / "manifest.jsonl"
    )
    events = [
        json.loads(line)
        for line in manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    event = events[0]
    detection = event["change_detection"]
    assert event["action"] == "before"
    assert event["path"] == "notes.txt"
    assert isinstance(event["path_hash"], str)
    assert isinstance(event["version"], str)
    assert detection["exists"] is True
    assert detection["size"] == len("before\n")
    assert isinstance(detection["mtime_ns"], int)
    assert isinstance(detection["sha256"], str)
    object_path = home / ".mycli" / "file-history" / "demo" / "objects" / event["version"]
    assert object_path.read_text(encoding="utf-8") == "before\n"


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


def test_file_history_finalize_appends_after_version_event(tmp_path) -> None:
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
        tool_name="Edit",
    )
    path.write_text("after\n", encoding="utf-8")

    result = service.finalize_snapshot(session_id="demo", snapshot_id=snapshot.snapshot_id)

    assert result.retained is True
    manifest_path = home / ".mycli" / "file-history" / "demo" / "manifest.jsonl"
    events = [
        json.loads(line)
        for line in manifest_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert [event["action"] for event in events] == ["before", "after"]
    assert events[0]["version"].endswith("@v1")
    assert events[1]["version"].endswith("@v2")
    object_root = home / ".mycli" / "file-history" / "demo" / "objects"
    assert (object_root / events[0]["version"]).read_text(encoding="utf-8") == "before\n"
    assert (object_root / events[1]["version"]).read_text(encoding="utf-8") == "after\n"


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


def test_file_history_skips_sensitive_paths(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    (workspace / ".env").write_text("TOKEN=secret\n", encoding="utf-8")
    service = FileHistoryService(home_dir=home, workspace_root=workspace)

    result = service.snapshot_path(
        session_id="demo",
        turn_id="turn_1",
        raw_path=".env",
        tool_name="Edit",
    )

    assert result.error is None
    assert result.retained is False
    assert not (home / ".mycli" / "file-history" / "demo").exists()


def test_file_history_skips_oversized_files(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    (workspace / "large.txt").write_text("abcdef", encoding="utf-8")
    service = FileHistoryService(
        home_dir=home,
        workspace_root=workspace,
        max_file_bytes=5,
    )

    result = service.snapshot_path(
        session_id="demo",
        turn_id="turn_1",
        raw_path="large.txt",
        tool_name="Edit",
    )

    assert result.error is None
    assert result.retained is False
    assert not (home / ".mycli" / "file-history" / "demo").exists()


def test_file_history_retention_discards_old_snapshots_and_garbage_collects_objects(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.mkdir()
    path = workspace / "notes.txt"
    path.write_text("v0\n", encoding="utf-8")
    service = FileHistoryService(
        home_dir=home,
        workspace_root=workspace,
        max_snapshots=2,
    )

    snapshot_ids: list[str] = []
    for index in range(3):
        snapshot = service.snapshot_path(
            session_id="demo",
            turn_id=f"turn_{index}",
            raw_path="notes.txt",
            tool_name="Write",
        )
        path.write_text(f"v{index + 1}\n", encoding="utf-8")
        service.finalize_snapshot(session_id="demo", snapshot_id=snapshot.snapshot_id)
        snapshot_ids.append(snapshot.snapshot_id)

    rows = service.list_snapshots(session_id="demo", limit=10)
    object_root = home / ".mycli" / "file-history" / "demo" / "objects"

    assert [row["snapshot_id"] for row in rows] == [snapshot_ids[2], snapshot_ids[1]]
    assert service.rewind_snapshot(session_id="demo", snapshot_id=snapshot_ids[0]).error == "Snapshot not found."
    assert {path.name for path in object_root.iterdir()} == {
        item
        for row in rows
        for item in _versions_for_snapshot(home=home, snapshot_id=str(row["snapshot_id"]))
    }
    assert not any(path.name.startswith(".") for path in object_root.iterdir())


def _versions_for_snapshot(*, home, snapshot_id: str) -> set[str]:
    manifest_path = home / ".mycli" / "file-history" / "demo" / "manifest.jsonl"
    versions: set[str] = set()
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        event = json.loads(line)
        if event.get("snapshot_id") == snapshot_id and isinstance(event.get("version"), str):
            versions.add(event["version"])
    return versions

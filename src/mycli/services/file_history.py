from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import shutil
from pathlib import Path
from uuid import uuid4

from mycli.tools.path_utils import resolve_workspace_path


@dataclass(slots=True, frozen=True)
class FileSnapshotResult:
    snapshot_id: str
    paths: tuple[str, ...] = ()
    error: str | None = None
    retained: bool = True


@dataclass(slots=True, frozen=True)
class FileRewindResult:
    snapshot_id: str
    restored_paths: tuple[str, ...] = ()
    deleted_paths: tuple[str, ...] = ()
    error: str | None = None


class FileHistoryService:
    def __init__(self, *, home_dir: Path, workspace_root: Path) -> None:
        self._home_dir = home_dir
        self._workspace_root = workspace_root

    def snapshot_path(
        self,
        *,
        session_id: str,
        turn_id: str,
        raw_path: str,
        tool_name: str,
    ) -> FileSnapshotResult:
        try:
            target = resolve_workspace_path(self._workspace_root, raw_path)
            relative_path = self._relative_path(target)
            snapshot_id = f"{turn_id}-{uuid4().hex}"
            snapshot_dir = self._snapshot_dir(session_id, snapshot_id)
            snapshot_dir.mkdir(parents=True, exist_ok=True)
            entry: dict[str, object] = {
                "path": relative_path,
                "tool_name": tool_name,
                "existed": target.exists(),
                "is_dir": target.is_dir(),
                "backup": None,
                "change_detection": self._change_detection_metadata(target),
            }
            if target.exists():
                backup_root = snapshot_dir / "backup"
                backup_path = backup_root / relative_path
                backup_path.parent.mkdir(parents=True, exist_ok=True)
                if target.is_dir():
                    shutil.copytree(target, backup_path)
                else:
                    shutil.copy2(target, backup_path)
                entry["backup"] = str(Path("backup") / relative_path)
            self._write_manifest(
                session_id=session_id,
                snapshot_id=snapshot_id,
                turn_id=turn_id,
                entries=(entry,),
            )
        except (OSError, ValueError) as exc:
            return FileSnapshotResult(snapshot_id="", error=str(exc))
        return FileSnapshotResult(snapshot_id=snapshot_id, paths=(relative_path,))

    def rewind_latest(self, *, session_id: str) -> FileRewindResult:
        snapshots = self._load_index(session_id)
        if not snapshots:
            return FileRewindResult(snapshot_id="", error="No file history snapshots.")
        latest = snapshots[-1]
        snapshot_id = str(latest["snapshot_id"])
        return self.rewind_snapshot(session_id=session_id, snapshot_id=snapshot_id)

    def rewind_snapshot(self, *, session_id: str, snapshot_id: str) -> FileRewindResult:
        manifest_path = self._snapshot_dir(session_id, snapshot_id) / "manifest.json"
        if not manifest_path.exists():
            return FileRewindResult(snapshot_id=snapshot_id, error="Snapshot not found.")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            entries = manifest.get("entries")
            if not isinstance(entries, list):
                raise ValueError("Snapshot manifest entries must be a list.")
            restored: list[str] = []
            deleted: list[str] = []
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                relative_path = str(entry["path"])
                target = resolve_workspace_path(self._workspace_root, relative_path)
                post_change_detection = entry.get("post_change_detection")
                if isinstance(post_change_detection, dict):
                    current = self._change_detection_metadata(target)
                    if not self._change_detection_matches(
                        current,
                        post_change_detection,
                    ):
                        return FileRewindResult(
                            snapshot_id=snapshot_id,
                            error=(
                                f"Cannot rewind {relative_path}: "
                                "changed after snapshot."
                            ),
                        )
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                relative_path = str(entry["path"])
                target = resolve_workspace_path(self._workspace_root, relative_path)
                existed = bool(entry.get("existed"))
                backup = entry.get("backup")
                if existed and isinstance(backup, str):
                    backup_path = self._snapshot_dir(session_id, snapshot_id) / backup
                    self._restore_backup(backup_path=backup_path, target=target)
                    restored.append(relative_path)
                    continue
                if target.exists():
                    self._remove_path(target)
                    deleted.append(relative_path)
        except (OSError, ValueError, json.JSONDecodeError, KeyError) as exc:
            return FileRewindResult(snapshot_id=snapshot_id, error=str(exc))
        return FileRewindResult(
            snapshot_id=snapshot_id,
            restored_paths=tuple(restored),
            deleted_paths=tuple(deleted),
        )

    def finalize_snapshot(self, *, session_id: str, snapshot_id: str) -> FileSnapshotResult:
        manifest_path = self._snapshot_dir(session_id, snapshot_id) / "manifest.json"
        if not manifest_path.exists():
            return FileSnapshotResult(snapshot_id=snapshot_id, error="Snapshot not found.")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            entries = manifest.get("entries")
            if not isinstance(entries, list):
                raise ValueError("Snapshot manifest entries must be a list.")
            retained_paths: list[str] = []
            changed = False
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                relative_path = str(entry["path"])
                target = resolve_workspace_path(self._workspace_root, relative_path)
                before_change_detection = entry.get("change_detection")
                after_change_detection = self._change_detection_metadata(target)
                entry["post_change_detection"] = after_change_detection
                retained_paths.append(relative_path)
                if not isinstance(before_change_detection, dict):
                    changed = True
                    continue
                if not self._change_detection_matches(
                    before_change_detection,
                    after_change_detection,
                ):
                    changed = True
            if not changed:
                self.discard_snapshot(session_id=session_id, snapshot_id=snapshot_id)
                return FileSnapshotResult(
                    snapshot_id=snapshot_id,
                    paths=(),
                    retained=False,
                )
            manifest_path.write_text(
                json.dumps(manifest, indent=2, sort_keys=True),
                encoding="utf-8",
            )
        except (OSError, ValueError, json.JSONDecodeError, KeyError) as exc:
            return FileSnapshotResult(snapshot_id=snapshot_id, error=str(exc))
        return FileSnapshotResult(
            snapshot_id=snapshot_id,
            paths=tuple(retained_paths),
            retained=True,
        )

    def discard_snapshot(self, *, session_id: str, snapshot_id: str) -> None:
        snapshot_dir = self._snapshot_dir(session_id, snapshot_id)
        if snapshot_dir.exists():
            shutil.rmtree(snapshot_dir)
        index = [
            item
            for item in self._load_index(session_id)
            if item.get("snapshot_id") != snapshot_id
        ]
        self._write_index(session_id, index)

    def list_snapshots(
        self,
        *,
        session_id: str,
        limit: int = 10,
    ) -> tuple[dict[str, object], ...]:
        rows: list[dict[str, object]] = []
        for item in reversed(self._load_index(session_id)[-limit:]):
            snapshot_id = str(item.get("snapshot_id", ""))
            turn_id = str(item.get("turn_id", ""))
            manifest_path = self._snapshot_dir(session_id, snapshot_id) / "manifest.json"
            if not snapshot_id or not manifest_path.exists():
                continue
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            entries = manifest.get("entries")
            if not isinstance(entries, list):
                continue
            paths = tuple(
                str(entry.get("path"))
                for entry in entries
                if isinstance(entry, dict) and entry.get("path")
            )
            tool_name = ""
            for entry in entries:
                if isinstance(entry, dict) and isinstance(entry.get("tool_name"), str):
                    tool_name = str(entry["tool_name"])
                    break
            rows.append(
                {
                    "snapshot_id": snapshot_id,
                    "turn_id": turn_id,
                    "tool_name": tool_name,
                    "paths": paths,
                }
            )
        return tuple(rows)

    def _history_root(self, session_id: str) -> Path:
        return self._home_dir / ".mycli" / "file-history" / session_id

    def _snapshot_dir(self, session_id: str, snapshot_id: str) -> Path:
        return self._history_root(session_id) / snapshot_id

    def _relative_path(self, target: Path) -> str:
        return target.resolve().relative_to(self._workspace_root.resolve()).as_posix()

    def _write_manifest(
        self,
        *,
        session_id: str,
        snapshot_id: str,
        turn_id: str,
        entries: tuple[dict[str, object], ...],
    ) -> None:
        snapshot_dir = self._snapshot_dir(session_id, snapshot_id)
        manifest = {
            "snapshot_id": snapshot_id,
            "turn_id": turn_id,
            "entries": list(entries),
        }
        (snapshot_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        index = self._load_index(session_id)
        index.append({"snapshot_id": snapshot_id, "turn_id": turn_id})
        self._write_index(session_id, index)

    def _load_index(self, session_id: str) -> list[dict[str, object]]:
        path = self._history_root(session_id) / "index.json"
        if not path.exists():
            return []
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            return []
        return [item for item in payload if isinstance(item, dict)]

    def _write_index(self, session_id: str, index: list[dict[str, object]]) -> None:
        root = self._history_root(session_id)
        root.mkdir(parents=True, exist_ok=True)
        (root / "index.json").write_text(
            json.dumps(index, indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def _restore_backup(self, *, backup_path: Path, target: Path) -> None:
        if target.exists():
            self._remove_path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        if backup_path.is_dir():
            shutil.copytree(backup_path, target)
        else:
            shutil.copy2(backup_path, target)

    def _remove_path(self, path: Path) -> None:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()

    def _change_detection_metadata(self, target: Path) -> dict[str, object]:
        if not target.exists():
            return {
                "exists": False,
                "sha256": None,
                "size": None,
                "mtime_ns": None,
            }
        stat = target.stat()
        return {
            "exists": True,
            "sha256": self._content_sha256(target),
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }

    def _content_sha256(self, target: Path) -> str | None:
        if target.is_dir():
            return None
        hasher = hashlib.sha256()
        with target.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    def _change_detection_matches(
        self,
        left: dict[str, object],
        right: dict[str, object],
    ) -> bool:
        return (
            left.get("exists") == right.get("exists")
            and left.get("sha256") == right.get("sha256")
            and left.get("size") == right.get("size")
            and left.get("mtime_ns") == right.get("mtime_ns")
        )


__all__ = ["FileHistoryService", "FileRewindResult", "FileSnapshotResult"]

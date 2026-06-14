from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import shutil
from pathlib import Path
from uuid import uuid4

from mycli.tools.path_utils import resolve_workspace_path

MANIFEST_NAME = "manifest.jsonl"
OBJECTS_DIR = "objects"
DEFAULT_MAX_SNAPSHOTS = 100
DEFAULT_MAX_FILE_BYTES = 1_000_000
SENSITIVE_PATH_PARTS = frozenset(
    {
        ".env",
        ".mycli",
        ".ssh",
        ".gnupg",
        ".aws",
        ".kube",
        "id_rsa",
        "id_ed25519",
    }
)


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
    """Append-only file history for file-tool mutations.

    The persistent store is intentionally not a VCS. It records full-file
    versions for recoverability and an append-only manifest for observability:

    ~/.mycli/file-history/<session_id>/
      objects/<path_hash>@vN
      manifest.jsonl
    """

    def __init__(
        self,
        *,
        home_dir: Path,
        workspace_root: Path,
        max_snapshots: int = DEFAULT_MAX_SNAPSHOTS,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    ) -> None:
        self._home_dir = home_dir
        self._workspace_root = workspace_root
        self._max_snapshots = max_snapshots
        self._max_file_bytes = max_file_bytes

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
            if not self._should_track_path(relative_path):
                return FileSnapshotResult(snapshot_id="", retained=False)
            if target.exists() and target.is_file() and target.stat().st_size > self._max_file_bytes:
                return FileSnapshotResult(snapshot_id="", retained=False)
            snapshot_id = f"{turn_id}-{uuid4().hex}"
            path_hash = self._path_hash(relative_path)
            before_detection = self._change_detection_metadata(target)
            before_version = (
                self._store_file_version(
                    session_id=session_id,
                    path_hash=path_hash,
                    source=target,
                )
                if target.exists() and not target.is_dir()
                else None
            )
            self._append_event(
                session_id=session_id,
                event={
                    "type": "snapshot",
                    "action": "before",
                    "snapshot_id": snapshot_id,
                    "turn_id": turn_id,
                    "tool_name": tool_name,
                    "path": relative_path,
                    "path_hash": path_hash,
                    "version": before_version,
                    "existed": target.exists(),
                    "is_dir": target.is_dir(),
                    "change_detection": before_detection,
                },
            )
        except (OSError, ValueError) as exc:
            return FileSnapshotResult(snapshot_id="", error=str(exc))
        return FileSnapshotResult(snapshot_id=snapshot_id, paths=(relative_path,))

    def rewind_latest(self, *, session_id: str) -> FileRewindResult:
        rows = self.list_snapshots(session_id=session_id, limit=1)
        if not rows:
            return FileRewindResult(snapshot_id="", error="No file history snapshots.")
        snapshot_id = str(rows[0]["snapshot_id"])
        return self.rewind_snapshot(session_id=session_id, snapshot_id=snapshot_id)

    def rewind_snapshot(self, *, session_id: str, snapshot_id: str) -> FileRewindResult:
        try:
            before = self._snapshot_event(
                session_id=session_id,
                snapshot_id=snapshot_id,
                action="before",
            )
            if before is None:
                return FileRewindResult(snapshot_id=snapshot_id, error="Snapshot not found.")
            after = self._snapshot_event(
                session_id=session_id,
                snapshot_id=snapshot_id,
                action="after",
            )
            if self._is_discarded(session_id, snapshot_id):
                return FileRewindResult(snapshot_id=snapshot_id, error="Snapshot not found.")
            relative_path = str(before["path"])
            target = resolve_workspace_path(self._workspace_root, relative_path)
            post_change_detection = after.get("change_detection") if after is not None else None
            if isinstance(post_change_detection, dict):
                current = self._change_detection_metadata(target)
                if not self._change_detection_matches(current, post_change_detection):
                    return FileRewindResult(
                        snapshot_id=snapshot_id,
                        error=f"Cannot rewind {relative_path}: changed after snapshot.",
                    )

            restored: list[str] = []
            deleted: list[str] = []
            existed = bool(before.get("existed"))
            before_version = before.get("version")
            if existed and isinstance(before_version, str):
                self._restore_version(
                    session_id=session_id,
                    version=before_version,
                    target=target,
                )
                restored.append(relative_path)
            elif existed and bool(before.get("is_dir")):
                return FileRewindResult(
                    snapshot_id=snapshot_id,
                    error=f"Cannot rewind directory snapshot: {relative_path}",
                )
            elif target.exists():
                self._remove_path(target)
                deleted.append(relative_path)
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
            return FileRewindResult(snapshot_id=snapshot_id, error=str(exc))
        return FileRewindResult(
            snapshot_id=snapshot_id,
            restored_paths=tuple(restored),
            deleted_paths=tuple(deleted),
        )

    def finalize_snapshot(self, *, session_id: str, snapshot_id: str) -> FileSnapshotResult:
        try:
            before = self._snapshot_event(
                session_id=session_id,
                snapshot_id=snapshot_id,
                action="before",
            )
            if before is None:
                return FileSnapshotResult(snapshot_id=snapshot_id, error="Snapshot not found.")
            if self._is_discarded(session_id, snapshot_id):
                return FileSnapshotResult(snapshot_id=snapshot_id, paths=(), retained=False)
            if self._snapshot_event(
                session_id=session_id,
                snapshot_id=snapshot_id,
                action="after",
            ) is not None:
                return FileSnapshotResult(
                    snapshot_id=snapshot_id,
                    paths=(str(before["path"]),),
                    retained=True,
                )

            relative_path = str(before["path"])
            target = resolve_workspace_path(self._workspace_root, relative_path)
            before_detection = before.get("change_detection")
            after_detection = self._change_detection_metadata(target)
            if isinstance(before_detection, dict) and self._change_detection_matches(
                before_detection,
                after_detection,
            ):
                self.discard_snapshot(session_id=session_id, snapshot_id=snapshot_id)
                return FileSnapshotResult(
                    snapshot_id=snapshot_id,
                    paths=(),
                    retained=False,
                )
            path_hash = str(before["path_hash"])
            if target.exists() and target.is_file() and target.stat().st_size > self._max_file_bytes:
                self.discard_snapshot(session_id=session_id, snapshot_id=snapshot_id)
                return FileSnapshotResult(snapshot_id=snapshot_id, paths=(), retained=False)
            after_version = (
                self._store_file_version(
                    session_id=session_id,
                    path_hash=path_hash,
                    source=target,
                )
                if target.exists() and not target.is_dir()
                else None
            )
            self._append_event(
                session_id=session_id,
                event={
                    "type": "snapshot",
                    "action": "after",
                    "snapshot_id": snapshot_id,
                    "turn_id": str(before["turn_id"]),
                    "tool_name": str(before["tool_name"]),
                    "path": relative_path,
                    "path_hash": path_hash,
                    "version": after_version,
                    "existed": target.exists(),
                    "is_dir": target.is_dir(),
                    "change_detection": after_detection,
                },
            )
            self.prune(session_id=session_id)
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
            return FileSnapshotResult(snapshot_id=snapshot_id, error=str(exc))
        return FileSnapshotResult(
            snapshot_id=snapshot_id,
            paths=(relative_path,),
            retained=True,
        )

    def prune(self, *, session_id: str) -> None:
        if self._max_snapshots <= 0:
            return
        newest_first = self.list_snapshots(session_id=session_id, limit=10**9)
        retained_ids = [str(row["snapshot_id"]) for row in reversed(newest_first)]
        stale_ids = retained_ids[:-self._max_snapshots]
        if not stale_ids:
            self._garbage_collect_objects(session_id=session_id)
            return
        discarded = self._discarded_snapshot_ids(self._load_events(session_id))
        for snapshot_id in stale_ids:
            if snapshot_id not in discarded:
                self.discard_snapshot(session_id=session_id, snapshot_id=snapshot_id)
        self._garbage_collect_objects(session_id=session_id)

    def discard_snapshot(self, *, session_id: str, snapshot_id: str) -> None:
        self._append_event(
            session_id=session_id,
            event={
                "type": "snapshot",
                "action": "discard",
                "snapshot_id": snapshot_id,
            },
        )

    def list_snapshots(
        self,
        *,
        session_id: str,
        limit: int = 10,
    ) -> tuple[dict[str, object], ...]:
        events = self._load_events(session_id)
        discarded = self._discarded_snapshot_ids(events)
        before_by_id: dict[str, dict[str, object]] = {}
        after_by_id: dict[str, dict[str, object]] = {}
        order: list[str] = []
        for event in events:
            snapshot_id = self._event_snapshot_id(event)
            if not snapshot_id:
                continue
            action = event.get("action")
            if action == "before":
                before_by_id[snapshot_id] = event
                if snapshot_id not in order:
                    order.append(snapshot_id)
            elif action == "after":
                after_by_id[snapshot_id] = event

        rows: list[dict[str, object]] = []
        for snapshot_id in reversed(order):
            if snapshot_id in discarded:
                continue
            before = before_by_id.get(snapshot_id)
            if before is None:
                continue
            rows.append(
                {
                    "snapshot_id": snapshot_id,
                    "turn_id": str(before.get("turn_id", "")),
                    "tool_name": str(before.get("tool_name", "")),
                    "paths": (str(before.get("path", "")),),
                }
            )
            if len(rows) >= limit:
                break
        return tuple(rows)

    def _history_root(self, session_id: str) -> Path:
        return self._home_dir / ".mycli" / "file-history" / session_id

    def _objects_root(self, session_id: str) -> Path:
        return self._history_root(session_id) / OBJECTS_DIR

    def _manifest_path(self, session_id: str) -> Path:
        return self._history_root(session_id) / MANIFEST_NAME

    def _relative_path(self, target: Path) -> str:
        return target.resolve().relative_to(self._workspace_root.resolve()).as_posix()

    def _path_hash(self, relative_path: str) -> str:
        return hashlib.sha256(relative_path.encode("utf-8")).hexdigest()[:16]

    def _store_file_version(
        self,
        *,
        session_id: str,
        path_hash: str,
        source: Path,
    ) -> str:
        version = f"{path_hash}@v{self._next_version(session_id, path_hash)}"
        target = self._objects_root(session_id) / version
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
        try:
            shutil.copy2(source, temporary)
            temporary.replace(target)
        finally:
            if temporary.exists():
                temporary.unlink()
        return version

    def _next_version(self, session_id: str, path_hash: str) -> int:
        latest = 0
        for event in self._load_events(session_id):
            if event.get("path_hash") != path_hash:
                continue
            version = event.get("version")
            if not isinstance(version, str):
                continue
            prefix = f"{path_hash}@v"
            if not version.startswith(prefix):
                continue
            try:
                latest = max(latest, int(version.removeprefix(prefix)))
            except ValueError:
                continue
        return latest + 1

    def _restore_version(self, *, session_id: str, version: str, target: Path) -> None:
        source = self._objects_root(session_id) / version
        if not source.exists():
            raise ValueError(f"File history object not found: {version}")
        if target.exists():
            self._remove_path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    def _append_event(self, *, session_id: str, event: dict[str, object]) -> None:
        path = self._manifest_path(session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(event, sort_keys=True, separators=(",", ":")))
            file.write("\n")

    def _load_events(self, session_id: str) -> list[dict[str, object]]:
        path = self._manifest_path(session_id)
        if not path.exists():
            return []
        events: list[dict[str, object]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                events.append(payload)
        return events

    def _should_track_path(self, relative_path: str) -> bool:
        parts = Path(relative_path).parts
        if any(part in SENSITIVE_PATH_PARTS for part in parts):
            return False
        name = parts[-1] if parts else relative_path
        if name.startswith(".env"):
            return False
        return True

    def _snapshot_event(
        self,
        *,
        session_id: str,
        snapshot_id: str,
        action: str,
    ) -> dict[str, object] | None:
        for event in reversed(self._load_events(session_id)):
            if event.get("snapshot_id") == snapshot_id and event.get("action") == action:
                return event
        return None

    def _is_discarded(self, session_id: str, snapshot_id: str) -> bool:
        return snapshot_id in self._discarded_snapshot_ids(self._load_events(session_id))

    def _discarded_snapshot_ids(self, events: list[dict[str, object]]) -> set[str]:
        return {
            snapshot_id
            for event in events
            if event.get("action") == "discard"
            for snapshot_id in (self._event_snapshot_id(event),)
            if snapshot_id
        }

    def _event_snapshot_id(self, event: dict[str, object]) -> str:
        snapshot_id = event.get("snapshot_id")
        return snapshot_id if isinstance(snapshot_id, str) else ""

    def _remove_path(self, path: Path) -> None:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()

    def _garbage_collect_objects(self, *, session_id: str) -> None:
        objects_root = self._objects_root(session_id)
        if not objects_root.exists():
            return
        referenced = self._referenced_versions(self._load_events(session_id))
        for path in objects_root.iterdir():
            if path.name.startswith("."):
                continue
            if path.name not in referenced and path.is_file():
                path.unlink()

    def _referenced_versions(self, events: list[dict[str, object]]) -> set[str]:
        discarded = self._discarded_snapshot_ids(events)
        referenced: set[str] = set()
        for event in events:
            snapshot_id = self._event_snapshot_id(event)
            if snapshot_id in discarded:
                continue
            version = event.get("version")
            if isinstance(version, str):
                referenced.add(version)
        return referenced

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

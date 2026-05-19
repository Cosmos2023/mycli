from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import hashlib
import os
from pathlib import Path


@dataclass(slots=True, frozen=True)
class FileSnapshot:
    path: str
    sha256: str
    mtime_ns: int
    size: int
    captured_at: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


class FileSnapshotStore:
    def __init__(self) -> None:
        self._snapshots: dict[str, FileSnapshot] = {}

    def record(self, snapshot: FileSnapshot) -> None:
        self._snapshots[snapshot.path] = snapshot

    def latest(self, path: str) -> FileSnapshot | None:
        return self._snapshots.get(path)


def build_file_snapshot(*, workspace_root: Path, path: Path) -> FileSnapshot:
    root = workspace_root.resolve()
    resolved = path.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("Path must stay within the current workspace.")
    stat = resolved.stat()
    return build_file_snapshot_from_bytes(
        workspace_root=workspace_root,
        path=path,
        content=resolved.read_bytes(),
        stat_result=stat,
    )


def build_file_snapshot_from_bytes(
    *,
    workspace_root: Path,
    path: Path,
    content: bytes,
    stat_result: os.stat_result,
) -> FileSnapshot:
    root = workspace_root.resolve()
    resolved = path.resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError("Path must stay within the current workspace.")
    return FileSnapshot(
        path=resolved.relative_to(root).as_posix(),
        sha256=hashlib.sha256(content).hexdigest(),
        mtime_ns=stat_result.st_mtime_ns,
        size=len(content),
        captured_at=datetime.now(UTC).isoformat(),
    )

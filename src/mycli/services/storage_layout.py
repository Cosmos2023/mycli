from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


def validate_storage_session_id(session_id: str) -> None:
    if (
        not session_id
        or session_id.startswith("<")
        or session_id.endswith(">")
        or "/" in session_id
        or "\\" in session_id
        or ".." in session_id
    ):
        raise ValueError(f"invalid storage session id: {session_id!r}")


@dataclass(frozen=True, slots=True)
class MycliStorageLayout:
    """Centralized paths under the user's mycli home."""

    root: Path

    @classmethod
    def from_home_dir(cls, home_dir: Path) -> "MycliStorageLayout":
        return cls(root=home_dir / ".mycli")

    @property
    def sessions_db_path(self) -> Path:
        return self.root / "sessions.db"

    @property
    def legacy_sessions_dir(self) -> Path:
        return self.root / "sessions"

    @property
    def sessions_dir(self) -> Path:
        return self.root / "sessions"

    @property
    def traces_dir(self) -> Path:
        return self.root / "traces"

    @property
    def artifacts_dir(self) -> Path:
        return self.root / "artifacts"

    @property
    def logs_dir(self) -> Path:
        return self.root / "logs"

    def trace_path(self, session_id: str) -> Path:
        validate_storage_session_id(session_id)
        return self.traces_dir / f"{session_id}-trace.jsonl"

    def legacy_trace_path(self, session_id: str) -> Path:
        validate_storage_session_id(session_id)
        return self.legacy_sessions_dir / f"{session_id}-trace.jsonl"

    def session_dir(self, session_id: str) -> Path:
        validate_storage_session_id(session_id)
        return self.sessions_dir / session_id

    def session_snapshot_path(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "session.json"

    def session_events_path(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "events.jsonl"

    def task_output_dir(self, session_id: str) -> Path:
        return self.session_dir(session_id) / "tasks"

    def task_output_path(self, session_id: str, task_id: str) -> Path:
        validate_storage_session_id(session_id)
        validate_storage_session_id(task_id)
        return self.task_output_dir(session_id) / task_id / "output.txt"


__all__ = ["MycliStorageLayout"]

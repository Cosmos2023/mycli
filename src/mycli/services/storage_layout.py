from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


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
    def traces_dir(self) -> Path:
        return self.root / "traces"

    @property
    def artifacts_dir(self) -> Path:
        return self.root / "artifacts"

    @property
    def logs_dir(self) -> Path:
        return self.root / "logs"

    def trace_path(self, session_id: str) -> Path:
        return self.traces_dir / f"{session_id}-trace.jsonl"

    def legacy_trace_path(self, session_id: str) -> Path:
        return self.legacy_sessions_dir / f"{session_id}-trace.jsonl"


__all__ = ["MycliStorageLayout"]

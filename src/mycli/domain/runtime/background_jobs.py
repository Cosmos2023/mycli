from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


BackgroundJobOwner = Literal["shell", "subagent"]
BackgroundJobState = Literal[
    "running",
    "completed",
    "failed",
    "killed",
    "cancelled",
    "timed_out",
    "unknown",
]


@dataclass(frozen=True, slots=True)
class BackgroundJobSummary:
    job_id: str
    owner: BackgroundJobOwner
    state: BackgroundJobState
    owner_turn_id: str | None = None
    started_at: str | None = None
    last_event_at: str | None = None
    completed_at: str | None = None
    timeout_seconds: int | None = None
    terminal_summary: str | None = None
    output_chars: int | None = None

    @property
    def is_running(self) -> bool:
        return self.state == "running"

    @property
    def is_terminal(self) -> bool:
        return self.state in {"completed", "failed", "killed", "cancelled", "timed_out"}

    def to_diagnostic_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "job_id": self.job_id,
            "owner": self.owner,
            "state": self.state,
        }
        optional: dict[str, object | None] = {
            "owner_turn_id": self.owner_turn_id,
            "started_at": self.started_at,
            "last_event_at": self.last_event_at,
            "completed_at": self.completed_at,
            "timeout_seconds": self.timeout_seconds,
            "terminal_summary": self.terminal_summary,
            "output_chars": self.output_chars,
        }
        payload.update({key: value for key, value in optional.items() if value is not None})
        return payload

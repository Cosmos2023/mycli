from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


ShellLifecycleKind = Literal[
    "shell.started",
    "shell.output",
    "shell.completed",
    "shell.removed",
    "shell.list.updated",
]


@dataclass(frozen=True, slots=True)
class ShellLifecycleEvent:
    kind: ShellLifecycleKind
    shell_id: str
    owner_session_id: str
    call_id: str | None
    sequence: int
    command_preview: str
    background: bool
    process_state: str
    terminal_state: str | None = None
    exit_code: int | None = None
    output_delta: str = ""
    next_cursor: int = 0
    output_chars: int = 0
    omitted_output_chars: int = 0
    cleanup_result: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    active_background_count: int | None = None
    shell_kind: str | None = None
    shell_edition: str | None = None

    def to_tui_payload(self) -> dict[str, object]:
        return {
            "shell_id": self.shell_id,
            "call_id": self.call_id,
            "sequence": self.sequence,
            "command_preview": self.command_preview,
            "background": self.background,
            "process_state": self.process_state,
            "terminal_state": self.terminal_state,
            "exit_code": self.exit_code,
            "output_delta": self.output_delta,
            "next_cursor": self.next_cursor,
            "output_chars": self.output_chars,
            "omitted_output_chars": self.omitted_output_chars,
            "cleanup_result": self.cleanup_result,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "active_background_count": self.active_background_count,
            "shell_kind": self.shell_kind,
            "shell_edition": self.shell_edition,
        }


__all__ = ["ShellLifecycleEvent", "ShellLifecycleKind"]

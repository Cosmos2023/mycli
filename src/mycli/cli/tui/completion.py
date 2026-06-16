from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mycli.cli.autocomplete import path_completion_candidates

_SLASH_COMMANDS: tuple[str, ...] = (
    "/help",
    "/status",
    "/context",
    "/usage",
    "/view",
    "/view default",
    "/view verbose",
    "/view focus",
    "/resume <session>",
    "/sessions",
    "/session-maintenance",
    "/session-maintenance --apply-empty",
    "/session-maintenance --apply-orphans",
    "/session-maintenance --apply-vacuum",
    "/search <query>",
    "/quit",
    "/tools",
    "/hooks",
    "/toolsets",
    "/bashes",
    "/changes",
    "/undo",
    "/extensions",
    "/plugin",
    "/plugin <plugin_id> <command_name>",
    "/plan",
    "/subagents",
    "/subagents <child_session_id>",
    "/memory",
    "/trace",
    "/trace-jsonl",
    "/logs",
    "/fork [source] <new-session> [message-index]",
    "/clear",
    "/theme",
    "/mark <name>",
    "/release-notes",
    "/stats",
    "/session",
)


def slash_command_candidates() -> tuple[str, ...]:
    return _SLASH_COMMANDS


@dataclass(slots=True)
class CompletionState:
    workspace_root: Path
    candidates: tuple[str, ...] = ()
    selected_index: int = 0
    visible: bool = False

    @property
    def selected(self) -> str | None:
        if not self.visible or not self.candidates:
            return None
        return self.candidates[self.selected_index]

    def update(self, value: str) -> None:
        token = _current_token(value)
        if token.startswith("/"):
            self.candidates = tuple(
                command for command in _SLASH_COMMANDS if command.startswith(token)
            )
        elif token.startswith("@"):
            self.candidates = path_completion_candidates(self.workspace_root, token)
        else:
            self.candidates = ()
        self.visible = bool(self.candidates)
        self.selected_index = 0

    def move_selection(self, offset: int) -> None:
        if not self.visible or not self.candidates:
            return
        self.selected_index = (self.selected_index + offset) % len(self.candidates)

    def accept_selected(self) -> str | None:
        selected = self.selected
        self.visible = False
        return selected

    def close(self) -> None:
        self.visible = False
        self.candidates = ()
        self.selected_index = 0


def _current_token(value: str) -> str:
    stripped = value.rstrip()
    if not stripped:
        return ""
    return stripped.split()[-1]

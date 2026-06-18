from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from mycli.cli.autocomplete import path_completion_candidates

_SLASH_COMMANDS: tuple[str, ...] = (
    "/help",
    "/status",
    "/status usage",
    "/status context",
    "/status stats",
    "/view",
    "/view default",
    "/view verbose",
    "/view focus",
    "/session",
    "/session list",
    "/session resume <session>",
    "/session fork [source] <new-session> [message-index]",
    "/session search <query>",
    "/session maintenance",
    "/session maintenance --apply-empty",
    "/session maintenance --apply-orphans",
    "/session maintenance --apply-vacuum",
    "/quit",
    "/tools",
    "/tools sets",
    "/tools permissions",
    "/tools hooks",
    "/tools extensions",
    "/tools plugins",
    "/tools plugins <plugin_id> <command_name>",
    "/tools skills",
    "/jobs",
    "/jobs subagents",
    "/jobs subagents <child_session_id>",
    "/jobs bashes",
    "/changes",
    "/changes undo",
    "/undo",
    "/plan",
    "/memory",
    "/trace",
    "/trace export",
    "/trace logs",
    "/clear",
    "/theme",
    "/mark <name>",
    "/release-notes",
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

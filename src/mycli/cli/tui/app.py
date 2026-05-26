from __future__ import annotations

from collections.abc import Callable
from typing import Any

from rich.text import Text
from textual import events
from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import Input, RichLog, Static

from mycli.application.turn_service import TurnService
from mycli.cli.repl import build_command_handler
from mycli.cli.tui.completion import CompletionState
from mycli.cli.tui.marks import startup_mark, startup_mark_names
from mycli.cli.tui.overlays import overlay_text, release_notes_text
from mycli.cli.tui.status import format_bottom_status


class MycliTuiApp(App[int]):
    CSS = """
    Screen {
        layout: vertical;
    }
    #transcript {
        height: 1fr;
        border: none;
        padding: 1 1;
    }
    #overlay {
        display: none;
        margin: 1 4;
        padding: 1 2;
        border: round $primary;
        background: $surface;
    }
    #input-row {
        height: 3;
        layout: horizontal;
        padding: 0 1;
    }
    #suggestions {
        height: auto;
        max-height: 6;
        margin: 0 1;
        display: none;
        text-style: dim;
    }
    #prompt-input {
        width: 1fr;
    }
    #bottom-status {
        height: 1;
        layout: horizontal;
        padding: 0 1;
    }
    #status-left {
        width: 1fr;
        text-style: dim;
    }
    #status-right {
        width: auto;
        text-style: dim;
    }
    """

    BINDINGS = [
        ("ctrl+c", "interrupt", "Interrupt"),
        ("escape", "close_overlay", "Close overlay"),
    ]

    def __init__(
        self,
        *,
        service: TurnService,
        input_func: Callable[[str], str] | None = None,
        output_func: Callable[[str], Any] | None = None,
    ) -> None:
        super().__init__()
        self.service = service
        self.input_func = input_func
        self.output_func = output_func
        self.command_handler = build_command_handler(service)
        self.rendered_transcript: list[str] = []
        self.status_left_text = ""
        self.status_right_text = ""
        self.suggestion_text = ""
        self.current_overlay_text = ""
        self.completion = CompletionState(workspace_root=service._config.workspace_root)

    def compose(self) -> ComposeResult:
        yield RichLog(id="transcript", wrap=True, markup=True, highlight=True)
        yield Static("", id="overlay")
        yield Static("", id="suggestions")
        with Container(id="input-row"):
            yield Input(placeholder=">", id="prompt-input")
        with Horizontal(id="bottom-status"):
            yield Static("", id="status-left")
            yield Static("", id="status-right")

    def on_mount(self) -> None:
        self._render_welcome()
        self._refresh_bottom_status()
        self.query_one("#prompt-input", Input).focus()

    def _render_welcome(self) -> None:
        config = self.service._config
        mark = startup_mark(getattr(config, "tui_startup_mark", "default"))
        workspace = getattr(config, "workspace_root", "")
        model = getattr(config, "model", "unknown")
        welcome = Text()
        welcome.append("╭─── mycli ─────────────────────────────────────────╮\n", style="blue")
        welcome.append("│                  Welcome back!                   │\n", style="magenta")
        for line in mark.splitlines():
            welcome.append(f"│ {line:^50} │\n", style="cyan")
        welcome.append(f"│ {model:<50} │\n", style="yellow")
        welcome.append(f"│ {str(workspace):<50.50} │\n", style="dim")
        welcome.append("│ Tips: /help  /context  /usage                    │\n", style="green")
        welcome.append("╰──────────────────────────────────────────────────╯", style="blue")
        self._write_transcript(welcome)

    def _refresh_bottom_status(self) -> None:
        snapshot = self.service._observability_service.snapshot()
        left, right = format_bottom_status(config=self.service._config, snapshot=snapshot)
        self.status_left_text = left
        self.status_right_text = right
        self.query_one("#status-left", Static).update(left)
        self.query_one("#status-right", Static).update(right)

    def _write_transcript(self, renderable: object, *, plain_text: str | None = None) -> None:
        text = plain_text if plain_text is not None else str(renderable)
        self.rendered_transcript.append(text)
        self.query_one("#transcript", RichLog).write(renderable)

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "prompt-input":
            return
        self.completion.update(event.value)
        self._render_suggestions()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "prompt-input":
            return
        value = event.value.strip()
        event.input.value = ""
        if not value:
            return
        if value.startswith("/"):
            self._dispatch_command(value)

    def on_key(self, event: events.Key) -> None:
        if not self.completion.visible:
            return
        if event.key == "down":
            self.completion.move_selection(1)
            self._render_suggestions()
            event.stop()
        elif event.key == "up":
            self.completion.move_selection(-1)
            self._render_suggestions()
            event.stop()
        elif event.key == "tab":
            selected = self.completion.accept_selected()
            if selected is not None:
                self.query_one("#prompt-input", Input).value = selected
            self._render_suggestions()
            event.stop()

    def _render_suggestions(self) -> None:
        suggestions = self.query_one("#suggestions", Static)
        if not self.completion.visible:
            self.suggestion_text = ""
            suggestions.display = False
            suggestions.update("")
            return
        lines: list[str] = []
        for index, candidate in enumerate(self.completion.candidates[:6]):
            prefix = "› " if index == self.completion.selected_index else "  "
            lines.append(f"{prefix}{candidate}")
        suggestions.display = True
        self.suggestion_text = "\n".join(lines)
        suggestions.update(self.suggestion_text)

    def _dispatch_command(self, value: str) -> None:
        if value == "/clear":
            self.query_one("#transcript", RichLog).clear()
            self.rendered_transcript.clear()
            return
        if value == "/release-notes":
            self._show_overlay(release_notes_text())
            return
        if value == "/theme":
            self._show_overlay(overlay_text(title="Theme", lines=("default",)))
            return
        if value.startswith("/mark"):
            names = ", ".join(startup_mark_names())
            self._show_overlay(overlay_text(title="Startup marks", lines=(names,)))
            return
        if value == "/help":
            self._show_overlay(overlay_text(title="Help", lines=self.service_help_lines()))
            return
        if value == "/context":
            self._show_overlay(overlay_text(title="Context", lines=self.service.inspect_context()))
            return
        if value == "/usage":
            self._show_overlay(overlay_text(title="Usage", lines=self.service.inspect_usage()))
            return
        if value == "/status":
            self._show_overlay(overlay_text(title="Status", lines=self.service.inspect_status()))
            return
        for line in self.command_handler(value):
            self._write_transcript(line)

    def service_help_lines(self) -> tuple[str, ...]:
        return (
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
            "/tools",
            "/bashes",
            "/changes",
            "/undo",
            "/plan",
            "/subagents",
            "/subagents <child_session_id>",
            "/memory",
            "/trace",
            "/fork [source] <new-session> [message-index]",
            "/stats",
            "/clear",
            "/theme",
            "/mark <name>",
            "/release-notes",
            "/quit",
        )

    def _show_overlay(self, text: str) -> None:
        overlay = self.query_one("#overlay", Static)
        self.current_overlay_text = text
        overlay.update(text)
        overlay.display = True

    def action_interrupt(self) -> None:
        self.query_one("#prompt-input", Input).value = ""

    def action_close_overlay(self) -> None:
        self.completion.close()
        self._render_suggestions()
        self.current_overlay_text = ""
        self.query_one("#overlay", Static).display = False


def run_tui(
    service: TurnService,
    *,
    input_func: Callable[[str], str] | None = None,
    output_func: Callable[[str], Any] | None = None,
) -> int:
    result = MycliTuiApp(
        service=service,
        input_func=input_func,
        output_func=output_func,
    ).run()
    return int(result or 0)

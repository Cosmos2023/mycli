from __future__ import annotations

from collections.abc import Callable
from typing import Any

from rich.text import Text
from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import Input, RichLog, Static

from mycli.application.turn_service import TurnService
from mycli.cli.repl import build_command_handler
from mycli.cli.tui.marks import startup_mark
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
    #input-row {
        height: 3;
        layout: horizontal;
        padding: 0 1;
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

    def compose(self) -> ComposeResult:
        yield RichLog(id="transcript", wrap=True, markup=True, highlight=True)
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

    def action_interrupt(self) -> None:
        self.query_one("#prompt-input", Input).value = ""

    def action_close_overlay(self) -> None:
        return None


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

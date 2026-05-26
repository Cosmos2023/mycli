from __future__ import annotations

from collections.abc import Callable
from time import monotonic
from typing import Any

from rich.measure import measure_renderables
from rich.segment import Segment
from rich.text import Text
from textual import events
from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal
from textual.geometry import Size
from textual.strip import Strip
from textual.widgets import Input, RichLog, Static

from mycli.application.turn_service import TurnService
from mycli.cli.repl import build_command_handler
from mycli.cli.tui.completion import CompletionState, slash_command_candidates
from mycli.cli.tui.marks import startup_mark, startup_mark_names
from mycli.cli.tui.overlays import overlay_text, release_notes_text
from mycli.cli.tui.status import format_bottom_status
from mycli.cli.tui.transcript import (
    execution_status_label,
    final_answer_renderable,
    phase_for_tool,
)


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
    #execution-status {
        height: 1;
        margin: 0 1;
        text-style: dim;
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
        self._transcript_renderables: list[object] = []
        self.status_left_text = ""
        self.status_right_text = ""
        self.suggestion_text = ""
        self.current_overlay_text = ""
        self.completion = CompletionState(workspace_root=service._config.workspace_root)
        self._before_send_input = ""
        self._turn_started_at: float | None = None
        self._execution_phase = "thinking"
        self._monotonic: Callable[[], float] = monotonic
        self.current_execution_status = ""
        self.current_stream_text = ""
        self.streamed_answer_text = ""
        self._last_rendered_stream_text = ""
        self._stream_transcript_index: int | None = None
        self._stream_richlog_start_line: int | None = None
        self._stream_richlog_line_count = 0
        self._stream_render_pending = False
        self._suppress_next_completion = False
        self.turn_running = False
        self.turn_interrupted = False

    def compose(self) -> ComposeResult:
        yield RichLog(id="transcript", wrap=True, markup=True, highlight=True)
        yield Static("", id="overlay")
        yield Static("", id="execution-status")
        yield Static("", id="suggestions")
        with Container(id="input-row"):
            yield Input(placeholder=">", id="prompt-input")
        with Horizontal(id="bottom-status"):
            yield Static("", id="status-left")
            yield Static("", id="status-right")

    def on_mount(self) -> None:
        self._render_welcome()
        self._refresh_bottom_status()
        self.set_interval(1.0, self._refresh_execution_status)
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
        self._transcript_renderables.append(renderable)
        self.query_one("#transcript", RichLog).write(renderable)

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "prompt-input":
            return
        if self._suppress_next_completion:
            self._suppress_next_completion = False
            self.completion.close()
            self._render_suggestions()
            return
        self.completion.update(event.value)
        self._render_suggestions()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "prompt-input":
            return
        value = event.value.strip()
        self._before_send_input = value
        if (
            self.completion.visible
            and value.startswith("/")
            and value not in slash_command_candidates()
        ):
            selected = self.completion.accept_selected()
            if selected is not None:
                self._suppress_next_completion = True
                event.input.value = selected
            self._render_suggestions()
            return
        self.completion.close()
        self._render_suggestions()
        event.input.value = ""
        if not value:
            return
        if value.startswith("/"):
            self._dispatch_command(value)
            return
        self.turn_running = True
        self.turn_interrupted = False
        self.run_worker(lambda: self._run_turn_worker(value), thread=True, exclusive=True)

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
                input_widget = self.query_one("#prompt-input", Input)
                input_widget.value = selected
                input_widget.focus()
            self._render_suggestions()
            event.prevent_default()
            event.stop()

    def _render_suggestions(self) -> None:
        suggestions = self.query_one("#suggestions", Static)
        if not self.completion.visible:
            self.suggestion_text = ""
            suggestions.display = False
            suggestions.update("")
            return
        lines: list[str] = []
        start = _suggestion_window_start(
            selected_index=self.completion.selected_index,
            total=len(self.completion.candidates),
            window_size=6,
        )
        visible_candidates = self.completion.candidates[start : start + 6]
        for offset, candidate in enumerate(visible_candidates):
            index = start + offset
            prefix = "› " if index == self.completion.selected_index else "  "
            lines.append(f"{prefix}{candidate}")
        suggestions.display = True
        self.suggestion_text = "\n".join(lines)
        suggestions.update(self.suggestion_text)

    def _dispatch_command(self, value: str) -> None:
        if value == "/quit":
            self.exit(0)
            return
        if value == "/clear":
            self.query_one("#transcript", RichLog).clear()
            self.rendered_transcript.clear()
            self._transcript_renderables.clear()
            self.current_stream_text = ""
            self.streamed_answer_text = ""
            self._last_rendered_stream_text = ""
            self._stream_transcript_index = None
            self._stream_richlog_start_line = None
            self._stream_richlog_line_count = 0
            self._stream_render_pending = False
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
        if value.startswith("/resume"):
            parts = value.split(maxsplit=1)
            session_id = parts[1] if len(parts) > 1 else None
            for line in self.command_handler(f"/resume {session_id}" if session_id else "/resume"):
                self._write_transcript(line)
            self._refresh_bottom_status()
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
        self.query_one("#prompt-input", Input).value = self._before_send_input
        self.turn_interrupted = self.turn_running
        self.turn_running = False
        self._turn_started_at = None
        self.current_execution_status = ""
        self.current_stream_text = ""
        self.streamed_answer_text = ""
        self._last_rendered_stream_text = ""
        self._stream_transcript_index = None
        self._stream_richlog_start_line = None
        self._stream_richlog_line_count = 0
        self._stream_render_pending = False
        self.query_one("#execution-status", Static).update("")

    def action_close_overlay(self) -> None:
        self.completion.close()
        self._render_suggestions()
        self.current_overlay_text = ""
        self.query_one("#overlay", Static).display = False

    def _run_turn_worker(self, message: str) -> None:
        self.call_from_thread(self._write_transcript, f"› {message}")
        self._turn_started_at = self._monotonic()
        self._execution_phase = "thinking"
        self.streamed_answer_text = ""
        self.current_stream_text = ""
        self._last_rendered_stream_text = ""
        self._stream_transcript_index = None
        self._stream_richlog_start_line = None
        self._stream_richlog_line_count = 0
        self._stream_render_pending = False
        self.call_from_thread(self._refresh_execution_status)
        response = self.service.handle_user_turn(message, stream_sink=self._stream_event)
        if not self.turn_interrupted:
            self.call_from_thread(lambda: self._write_final_answer(response.assistant_message))
        self._turn_started_at = None
        self.turn_running = False
        self.current_execution_status = ""
        self.call_from_thread(lambda: self.query_one("#execution-status", Static).update(""))
        self.current_stream_text = ""
        self.call_from_thread(self._refresh_bottom_status)

    def _stream_event(self, event: object) -> None:
        if self._turn_started_at is None or self.turn_interrupted:
            return
        kind = getattr(event, "kind", None)
        if kind == "text_delta":
            text = getattr(event, "text", "")
            if isinstance(text, str) and text:
                self.streamed_answer_text += text
                self.current_stream_text = self.streamed_answer_text
                self._execution_phase = "thinking"
                if not self._stream_render_pending:
                    self._stream_render_pending = True
                    self.call_from_thread(self._render_assistant_stream)
            return
        if kind == "reasoning":
            self._execution_phase = "thinking"
            self.call_from_thread(self._refresh_execution_status)
            return
        if kind == "heartbeat":
            self._execution_phase = "thinking"
            self.call_from_thread(self._refresh_execution_status)
            return
        if kind == "tool_call":
            name = getattr(event, "tool_name", None) or "tool"
            metadata = getattr(event, "metadata", {})
            path = metadata.get("path") if isinstance(metadata, dict) else None
            suffix = f" {path}" if isinstance(path, str) and path else ""
            phase = phase_for_tool(name)
            self._execution_phase = phase
            self.call_from_thread(self._write_transcript, f"Calling {name}{suffix}")
            self.call_from_thread(self._refresh_execution_status)
            return
        if kind == "completed":
            self.call_from_thread(self._refresh_execution_status)

    def _refresh_execution_status(self) -> None:
        if not self.turn_running or self._turn_started_at is None:
            return
        elapsed = self._monotonic() - self._turn_started_at
        status = execution_status_label(
            phase=self._execution_phase,
            elapsed_seconds=elapsed,
        )
        self.current_execution_status = status
        widget = self.query_one("#execution-status", Static)
        widget.update(status)

    def _render_assistant_stream(self) -> None:
        self._stream_render_pending = False
        if not self.current_stream_text:
            return
        if self.current_stream_text == self._last_rendered_stream_text:
            return
        self._last_rendered_stream_text = self.current_stream_text
        if self._stream_transcript_index is None:
            self._stream_transcript_index = len(self.rendered_transcript)
            self.rendered_transcript.append(self.current_stream_text)
            stream_renderable = Text(self.current_stream_text)
            self._transcript_renderables.append(stream_renderable)
            transcript = self.query_one("#transcript", RichLog)
            self._stream_richlog_start_line = len(transcript.lines)
            transcript.write(stream_renderable)
            self._stream_richlog_line_count = len(transcript.lines) - (
                self._stream_richlog_start_line or 0
            )
            self._refresh_execution_status()
            return
        if self._stream_transcript_index >= len(self.rendered_transcript):
            self._stream_transcript_index = None
            self._stream_richlog_start_line = None
            self._stream_richlog_line_count = 0
            self._render_assistant_stream()
            return
        self.rendered_transcript[self._stream_transcript_index] = self.current_stream_text
        stream_renderable = Text(self.current_stream_text)
        self._transcript_renderables[self._stream_transcript_index] = stream_renderable
        if self._stream_richlog_start_line is None:
            self._stream_transcript_index = len(self.rendered_transcript) - 1
            self._write_transcript(
                stream_renderable,
                plain_text=self.current_stream_text,
            )
            self._refresh_execution_status()
            return
        self._replace_richlog_stream_block(stream_renderable)
        self._refresh_execution_status()

    def _write_final_answer(self, answer: str) -> None:
        if not answer:
            return
        if self._stream_transcript_index is not None:
            self.current_stream_text = ""
            if self._stream_transcript_index < len(self.rendered_transcript):
                self.rendered_transcript[self._stream_transcript_index] = answer
                self._transcript_renderables[self._stream_transcript_index] = final_answer_renderable(
                    answer
                )
                if self._stream_richlog_start_line is not None:
                    self._replace_richlog_stream_block(final_answer_renderable(answer))
                return
            self._stream_transcript_index = None
            self._stream_richlog_start_line = None
            self._stream_richlog_line_count = 0
            self._write_transcript(final_answer_renderable(answer), plain_text=answer)
            return
        self._write_transcript(final_answer_renderable(answer), plain_text=answer)

    def _replace_richlog_stream_block(self, renderable: object) -> None:
        transcript = self.query_one("#transcript", RichLog)
        if self._stream_richlog_start_line is None:
            return
        new_lines, width = _render_richlog_lines(transcript, renderable)
        start = self._stream_richlog_start_line
        end = start + self._stream_richlog_line_count
        transcript.lines[start:end] = new_lines
        self._stream_richlog_line_count = len(new_lines)
        transcript._widest_line_width = max(transcript._widest_line_width, width)
        transcript.virtual_size = Size(transcript._widest_line_width, len(transcript.lines))
        transcript.refresh_lines(start, max(len(new_lines), end - start))


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


def _suggestion_window_start(
    *,
    selected_index: int,
    total: int,
    window_size: int,
) -> int:
    if total <= window_size:
        return 0
    return min(max(0, selected_index - window_size + 1), total - window_size)


def _render_richlog_lines(log: RichLog, content: object) -> tuple[list[Strip], int]:
    renderable = log._make_renderable(content)
    console = log.app.console
    render_options = console.options
    renderable_width = measure_renderables(console, render_options, [renderable]).maximum
    render_width = min(max(renderable_width, log.min_width), log.scrollable_content_region.width)
    render_options = render_options.update_width(render_width)
    segments = console.render(renderable, render_options)
    lines = list(Segment.split_lines(segments))
    if not lines:
        return [Strip.blank(render_width)], render_width
    strips = Strip.from_lines(lines)
    for strip in strips:
        strip.adjust_cell_length(render_width)
    widest = max(sum(segment.cell_length for segment in line) for line in lines)
    return strips, max(render_width, widest)

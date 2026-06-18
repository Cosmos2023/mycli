from __future__ import annotations

import asyncio
from pathlib import Path
from threading import Event
from types import SimpleNamespace

from rich.text import Text

from mycli.cli.tui.app import MycliTuiApp
from mycli.domain.runtime import RuntimeStreamEvent, TurnResponse, ViewMode


class FakeObservability:
    def snapshot(self):
        return SimpleNamespace(context_window={"input_tokens": 3566, "max_tokens": 12000})


class FakeService:
    def __init__(self, workspace_root: Path) -> None:
        self._config = SimpleNamespace(
            session_id="demo",
            workspace_root=workspace_root,
            model="deepseek-v4-flash",
            max_prompt_tokens=12000,
            tui_startup_mark="default",
            view_mode=ViewMode.DEFAULT,
            statusline_enabled=True,
        )
        self._observability_service = FakeObservability()
        self._session_service = SimpleNamespace(load_pending_decision=lambda _session_id: None)

    def inspect_status(self) -> tuple[str, ...]:
        return ("session=demo model=deepseek-v4-flash context=29.7%",)

    def current_context_window_metrics(self) -> dict[str, object]:
        snapshot = self._observability_service.snapshot()
        return dict(snapshot.context_window)


def test_tui_bottom_status_prefers_latest_context_window_metrics(tmp_path: Path) -> None:
    class Service(FakeService):
        def current_context_window_metrics(self) -> dict[str, object]:
            return {
                "input_tokens": 8818,
                "max_tokens": 100000,
                "usage_ratio": 0.08818,
                "source": "provider",
            }

    app = MycliTuiApp(service=Service(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.pause()
            assert "context 8,818 / 100,000 tokens" in app.status_right_text

    asyncio.run(run())


def test_tui_startup_renders_welcome_and_bottom_status(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.pause()
            transcript = "\n".join(app.rendered_transcript)
            assert "Welcome back!" in transcript
            assert "deepseek-v4-flash" in app.status_right_text
            assert "context 3,566 / 12,000 tokens" in app.status_right_text

    asyncio.run(run())


def test_tui_input_starts_focused(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.pause()
            assert app.query_one("#prompt-input").has_focus

    asyncio.run(run())


def test_tui_slash_completion_filters_and_tab_accepts(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.press("/", "s", "t", "a")
            assert "/status" in app.suggestion_text
            await pilot.press("down")
            await pilot.press("tab")
            assert app.query_one("#prompt-input").value == "/status usage"

    asyncio.run(run())


def test_tui_bare_slash_enter_accepts_selected_command_without_dispatching(
    tmp_path: Path,
) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.press("/")
            assert app.suggestion_text

            await pilot.press("enter")

            assert app.query_one("#prompt-input").value == "/help"
            assert app.suggestion_text == ""
            assert app.current_overlay_text == ""

    asyncio.run(run())


def test_tui_slash_completion_window_tracks_selected_item(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.press("/")
            for _ in range(9):
                await pilot.press("down")

            assert app.completion.selected == "/session"
            assert "› /session" in app.suggestion_text

    asyncio.run(run())


def test_tui_tab_accepts_completion_without_moving_focus(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.press("/", "s")
            assert app.query_one("#prompt-input").has_focus

            await pilot.press("tab")

            assert app.query_one("#prompt-input").value == "/status"
            assert app.query_one("#prompt-input").has_focus

    asyncio.run(run())


def test_tui_escape_closes_suggestions(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            await pilot.press("/", "s")
            assert app.suggestion_text
            await pilot.press("escape")
            assert app.suggestion_text == ""

    asyncio.run(run())


def test_tui_context_command_opens_overlay(tmp_path: Path) -> None:
    class Service(FakeService):
        def inspect_context(self) -> tuple[str, ...]:
            return ("budget input_tokens=3566 max_tokens=12000 usage_ratio=29.7%",)

    app = MycliTuiApp(service=Service(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            input_widget = app.query_one("#prompt-input")
            input_widget.value = "/context"
            await pilot.press("enter")
            assert "budget input_tokens=3566" in app.current_overlay_text
            await pilot.press("escape")
            assert app.current_overlay_text == ""

    asyncio.run(run())


def test_tui_clear_command_clears_transcript_view(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            app._write_transcript("hello")
            input_widget = app.query_one("#prompt-input")
            input_widget.value = "/clear"
            await pilot.press("enter")
            assert app.rendered_transcript == []

    asyncio.run(run())


def test_tui_clear_resets_stream_transcript_state(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test():
            app._stream_transcript_index = 2
            app._write_transcript("hello")

            app._dispatch_command("/clear")

            assert app.rendered_transcript == []
            assert app._stream_transcript_index is None

    asyncio.run(run())


def test_tui_enter_runs_turn_in_worker_and_renders_final_answer(tmp_path: Path) -> None:
    started = Event()
    release = Event()

    class Service(FakeService):
        def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
            assert message == "hello"
            started.set()
            if stream_sink is not None:
                stream_sink(
                    RuntimeStreamEvent(
                        kind="tool_call",
                        tool_name="Read",
                        metadata={"path": "README.md"},
                        )
                    )
            release.wait(timeout=1.0)
            return TurnResponse(assistant_message="**final** answer")

    app = MycliTuiApp(service=Service(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            input_widget = app.query_one("#prompt-input")
            input_widget.value = "hello"
            await pilot.press("enter")
            assert started.wait(timeout=1.0) is True
            assert app.turn_running is True
            assert input_widget.value == ""
            release.set()
            await pilot.pause(0.1)
            assert any("Read README.md" in item for item in app.rendered_transcript)
            assert any("**final** answer" == item for item in app.rendered_transcript)
            assert app.turn_running is False

    asyncio.run(run())


def test_tui_streams_tool_activity_with_calling_wording(tmp_path: Path) -> None:
    started = Event()
    release = Event()

    class Service(FakeService):
        def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
            assert message == "inspect"
            assert stream_sink is not None
            stream_sink(
                RuntimeStreamEvent(
                    kind="tool_call",
                    tool_name="Read",
                    metadata={"path": "src/mycli/cli/tui/app.py"},
                )
            )
            started.set()
            release.wait(timeout=1.0)
            return TurnResponse(assistant_message="done")

    app = MycliTuiApp(service=Service(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            input_widget = app.query_one("#prompt-input")
            input_widget.value = "inspect"
            await pilot.press("enter")
            assert started.wait(timeout=1.0) is True

            transcript = "\n".join(app.rendered_transcript)
            assert "Calling Read src/mycli/cli/tui/app.py" in transcript

            release.set()
            await pilot.pause(0.1)

    asyncio.run(run())


def test_tui_streams_assistant_text_before_turn_completes(tmp_path: Path) -> None:
    started = Event()
    release = Event()

    class Service(FakeService):
        def handle_user_turn(self, message: str, stream_sink=None) -> TurnResponse:
            assert message == "answer"
            assert stream_sink is not None
            stream_sink(RuntimeStreamEvent(kind="text_delta", text="hello"))
            stream_sink(RuntimeStreamEvent(kind="text_delta", text=" world"))
            started.set()
            release.wait(timeout=1.0)
            return TurnResponse(assistant_message="hello world")

    app = MycliTuiApp(service=Service(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            input_widget = app.query_one("#prompt-input")
            input_widget.value = "answer"
            await pilot.press("enter")
            assert started.wait(timeout=1.0) is True

            assert app.streamed_answer_text == "hello world"
            assert "hello world" in app.rendered_transcript

            release.set()
            await pilot.pause(0.1)

            assert app.current_stream_text == ""
            assert app.rendered_transcript.count("hello world") == 1

    asyncio.run(run())


def test_tui_streaming_updates_transcript_without_full_redraw(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test():
            app.current_stream_text = "hello"
            app._render_assistant_stream()
            app.current_stream_text = "hello world"
            app._render_assistant_stream()

            assert "hello world" in app.rendered_transcript
            assert not hasattr(app, "_redraw_transcript")

    asyncio.run(run())


def test_tui_streaming_uses_plain_text_before_final_markdown(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test():
            app.current_stream_text = "**partial**"
            app._render_assistant_stream()

            assert isinstance(app._transcript_renderables[-1], Text)

            app._write_final_answer("**final**")

            assert not isinstance(app._transcript_renderables[-1], Text)
            assert app.rendered_transcript[-1] == "**final**"

    asyncio.run(run())


def test_tui_stream_events_coalesce_pending_render_callbacks(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))
    callbacks = 0

    def call_from_thread(callback):
        nonlocal callbacks
        callbacks += 1

    app.call_from_thread = call_from_thread  # type: ignore[method-assign]
    app._turn_started_at = 1.0
    app.turn_running = True

    app._stream_event(RuntimeStreamEvent(kind="text_delta", text="a"))
    app._stream_event(RuntimeStreamEvent(kind="text_delta", text="b"))
    app._stream_event(RuntimeStreamEvent(kind="text_delta", text="c"))

    assert app.streamed_answer_text == "abc"
    assert callbacks == 1


def test_tui_final_answer_replaces_different_stream_text(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test():
            app.current_stream_text = "partial"
            app._render_assistant_stream()

            app._write_final_answer("final answer")

            assert "partial" not in app.rendered_transcript
            assert app.rendered_transcript.count("final answer") == 1

    asyncio.run(run())


def test_tui_ctrl_c_restores_pre_send_input(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            input_widget = app.query_one("#prompt-input")
            input_widget.value = "inspect repo"
            app._before_send_input = "inspect repo"
            app.turn_running = True
            await pilot.press("ctrl+c")
            assert input_widget.value == "inspect repo"
            assert app.turn_interrupted is True

    asyncio.run(run())


def test_tui_resume_command_renders_session_lines(tmp_path: Path) -> None:
    class Service(FakeService):
        def resume_session(self, session_id=None) -> tuple[str, ...]:
            return (f"resumed {session_id}", "messages=3")

    app = MycliTuiApp(service=Service(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            input_widget = app.query_one("#prompt-input")
            input_widget.value = "/resume demo"
            await pilot.press("enter")
            assert any("resumed demo" in item for item in app.rendered_transcript)

    asyncio.run(run())


def test_tui_quit_command_exits_app(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test() as pilot:
            input_widget = app.query_one("#prompt-input")
            input_widget.value = "/quit"
            await pilot.press("enter")
            await pilot.pause()
            assert not app.is_running

    asyncio.run(run())


def test_tui_execution_status_elapsed_updates_while_turn_runs(tmp_path: Path) -> None:
    app = MycliTuiApp(service=FakeService(tmp_path / "workspace"))

    async def run() -> None:
        async with app.run_test():
            app.turn_running = True
            app._turn_started_at = 100.0
            app._execution_phase = "thinking"
            app._monotonic = lambda: 112.4

            app._refresh_execution_status()

            assert app.current_execution_status == "Thinking... (12s)"

    asyncio.run(run())

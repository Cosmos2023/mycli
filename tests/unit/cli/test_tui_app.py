from __future__ import annotations

import asyncio
from pathlib import Path
from threading import Event
from types import SimpleNamespace

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
            assert app.query_one("#prompt-input").value == "/stats"

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
            assert any("Reading files" in item for item in app.rendered_transcript)
            assert any("**final** answer" == item for item in app.rendered_transcript)
            assert app.turn_running is False

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

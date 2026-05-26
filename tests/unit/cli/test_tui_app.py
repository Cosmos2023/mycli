from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from mycli.cli.tui.app import MycliTuiApp
from mycli.domain.runtime import ViewMode


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

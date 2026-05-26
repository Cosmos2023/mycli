# P6 TUI Shell Smoke

## Commands

- `uv run pytest tests/unit/cli/test_tui_completion.py tests/unit/cli/test_tui_status.py tests/unit/cli/test_tui_transcript.py tests/unit/cli/test_tui_app.py -q`
- `uv run pytest tests/unit/cli/test_main.py tests/integration/test_cli_repl.py -q`
- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`

## Covered

- `mycli` routes to TUI in interactive terminals.
- `mycli --plain` preserves line-oriented REPL behavior.
- Non-interactive stdout uses plain mode.
- Startup welcome screen renders without entering session history.
- Bottom status shows workspace, model, and context token usage.
- Slash completion supports prefix filtering, arrow selection, Tab accept, Enter execute, and Esc close.
- `@path` suggestions remain workspace-scoped.
- TUI overlays cover help/context/usage/status.
- `/resume <session>` dispatches as a normal slash command.
- TUI transcript summarizes execution path and renders final answers as Markdown.

## Not Covered

- No right sidebar.
- No full command palette.
- No `/model` picker.
- No `/init` project-file creation flow.
- No interactive `/diff` command.
- No voice/vim/editor mode.

## Result

- `uv run ruff check src tests`: passed.
- `uv run mypy src/mycli`: passed.
- `uv run pytest -q`: `893 passed`.

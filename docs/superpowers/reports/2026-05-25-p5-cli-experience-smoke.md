# P5 CLI Experience Smoke

## Commands

- `uv run pytest tests/unit/cli/test_main.py tests/integration/test_cli_repl.py -q`
- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`

## Covered

- `/status` reports session/model/provider/context state.
- `/view` can inspect and update view mode.
- Focus mode suppresses low-value activity and stream echo while keeping final answers.
- Verbose mode can retain stream lines.
- Large diffs report omitted tail counts.
- `@path` autocomplete suggests workspace-local paths and rejects outside traversal.

## Not Covered

- No full-screen TUI.
- No interactive diff expand/collapse.
- No prompt_toolkit integration.
- No voice/vim/editor mode.

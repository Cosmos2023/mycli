# Hook Lifecycle Foundation Completion

## Implementation

- Added hook registration snapshots and per-execution summaries to
  `HookManager` while keeping `execute()` backward compatible.
- Added safe hook summaries to local `tool_execution` trace payloads.
- Added `/hooks` inspection through `AgentRuntime`, `TurnService`, REPL, TUI
  help, and slash completion.
- Added a doctor `hooks` check for the built-in permission guard surface.
- Added provider-free `evaluation/hook_smoke.py`.

## Verification

- `uv run ruff check ...`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit/services/test_hooks.py tests/unit/application/test_tool_execution_service.py tests/unit/cli/test_main.py tests/unit/cli/test_tui_completion.py tests/unit/services/test_doctor_service.py -q`
- `uv run python evaluation/hook_smoke.py`
- `uv run pytest tests/unit tests/integration -q`

## Residual Risk

- This slice does not implement external shell hooks or user/plugin hook
  configuration. It only makes the existing internal hook lifecycle stable and
  diagnosable.

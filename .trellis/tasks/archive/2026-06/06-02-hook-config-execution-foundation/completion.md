# Hook Config Execution Foundation Completion

## Implementation

- Added repo/user `.mycli/hooks.json` discovery with structured diagnostics.
- Added safe configured hook execution through subprocess stdin/stdout JSON.
- Mapped configured hook results to `allow`, `deny`, `modify`, and `error`
  without changing provider-visible transcripts.
- Registered configured hooks in `AgentRuntime` alongside built-in hooks.
- Added safe `hook_execution` runtime trace rows for configured hook runs.
- Extended `/hooks` and doctor output to include configured hooks and config
  issues.
- Updated provider-free hook smoke to create and execute a configured hook.

## Verification

- `uv run ruff check ...`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit/services/test_configured_hooks.py tests/unit/services/test_hooks.py tests/unit/application/test_tool_execution_service.py tests/unit/services/test_doctor_service.py tests/unit/cli/test_main.py tests/unit/cli/test_tui_completion.py -q`
- `uv run python evaluation/hook_smoke.py`
- `uv run pytest tests/unit tests/integration -q`

## Residual Risk

- This slice intentionally does not implement full plugin lifecycle, hook
  approval prompts, allowlist persistence, hook revoke/test CLI subcommands,
  MCP/ACP integration, or subagent hook orchestration.

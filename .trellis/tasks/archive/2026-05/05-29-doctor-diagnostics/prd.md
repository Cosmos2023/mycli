# Doctor Diagnostics PRD

## Background

`mycli` now has a more mature local runtime foundation: SQLite-backed sessions,
trace storage, workspace logs, model raw payload logs, FileHistory rollback, MCP
config loading, and Python/Node TUI entrypoints. Hermes Agent has a broad
`doctor` command that checks configuration, dependencies, storage, and platform
state before users start debugging by hand. `mycli` needs a smaller read-only
equivalent focused on its current architecture.

## Goals

- Add a `mycli doctor` command that performs read-only local diagnostics.
- Report `ok`, `warning`, and `failed` checks with concise remediation details.
- Keep secrets hidden: API keys and tokens must never be printed.
- Reuse existing config, storage layout, MCP, logging, and CLI patterns.
- Avoid changing `AgentRuntime.handle_user_turn()` or model-visible request
  surfaces.

## Non-Goals

- No interactive setup wizard in this task.
- No real model call by default; avoid provider cost and side effects.
- No automatic config writes or repair actions.
- No broad Hermes parity for gateway, cron, dashboard, or plugin ecosystems.

## Required Checks

1. Config
   - Report whether config resolves successfully.
   - Show provider, protocol, model, and base URL.
   - Report API key presence without revealing the value.

2. Provider shape
   - Report whether configured provider/protocol values are supported by
     `mycli`.
   - Do not perform an LLM request in the default command.

3. Storage
   - Check `~/.mycli/sessions.db` exists.
   - Check SQLite can be opened.
   - Check key tables exist: `sessions`, `conversation_messages`,
     `turn_rollouts`.

4. Logs
   - Check `~/.mycli/logs/` is present or can be created by normal runtime.
   - Check expected paths: `agent.log`, `errors.log`, `model-events.jsonl`,
     and `model-raw/`.
   - Check the logs directory is writable.

5. FileHistory
   - Check `~/.mycli/file-history/`.
   - Check at least one `index.json` can be parsed when present.
   - Report missing history as a warning, not a failure.

6. TUI / Node TUI
   - Check Python TUI import path.
   - Check Node TUI source directory exists.
   - Check `node` and `npm` availability via PATH.

7. MCP Config
   - Reuse existing MCP config loader.
   - Report parse/load success and enabled server count.
   - Do not start MCP servers.

## Output Contract

Plain command:

```text
mycli doctor

✓ config: provider=deepseek protocol=chat_completions model=deepseek-v4-flash
✓ api_key: present
✓ sessions_db: ok
⚠ logs: agent.log missing; will be created after first runtime log
✗ mcp: invalid config ...

Summary: 3 ok, 1 warning, 1 failed
```

Programmatic tests may consume a structured result object, but the public CLI
contract is human-readable text.

## Acceptance Criteria

- `uv run mycli doctor` runs without requiring an API key beyond normal config
  resolution behavior.
- Doctor output never includes raw secret values.
- Unit tests cover success, warning, and failure checks.
- CLI tests cover the `doctor` subcommand and summary rendering.
- Existing `uv run pytest`, `uv run ruff check src tests`, and `uv run mypy`
  pass.

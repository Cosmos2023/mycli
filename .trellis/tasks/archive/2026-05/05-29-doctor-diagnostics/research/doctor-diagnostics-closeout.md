# Doctor Diagnostics Closeout

## Scope

- Date: 2026-05-30
- Workspace: `/Users/cosmos/Desktop/mycli`
- Task: `.trellis/tasks/05-29-doctor-diagnostics`
- Status before closeout: `in_progress`

## Acceptance Mapping

`mycli doctor` now performs read-only diagnostics for:

- Config resolution and provider/protocol/model/base URL display.
- API key presence without printing the secret value.
- SQLite session DB openability and required tables.
- User-home log layout.
- FileHistory index presence/parsing.
- Python TUI importability.
- Node TUI source presence and `node`/`npm` availability.
- MCP config load/count without starting servers.

Warnings remain non-fatal. Failed checks produce non-zero CLI exit status. The
default command does not perform a model/provider request.

## Verification

```text
uv run mycli doctor
```

Result:

```text
mycli doctor
[OK] config: provider=deepseek protocol=chat_completions model=deepseek-v4-flash base_url=https://api.deepseek.com
[OK] api_key: api_key: present
[OK] sessions_db: openable /Users/cosmos/.mycli/sessions.db
[OK] logs: logs present (/Users/cosmos/.mycli/logs)
[OK] file_history: 2 index file(s) found (/Users/cosmos/.mycli/file-history)
[OK] python_tui: mycli.cli.tui importable
[OK] node_tui: source present /Users/cosmos/Desktop/mycli/tui/node
[OK] node: node: /usr/local/bin/node
[OK] npm: npm: /usr/local/bin/npm
[OK] mcp: mcp: 0 configured, 0 enabled
Summary: 10 ok, 0 warning, 0 failed
```

```text
uv run pytest tests/unit/services/test_workspace_log_service.py \
  tests/unit/services/test_doctor_service.py \
  tests/unit/cli/test_main.py \
  tests/integration/test_cli_repl.py \
  tests/unit/cli/test_tui_completion.py \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_rebind_session_updates_workspace_log_context -q
```

Result:

```text
102 passed in 0.87s
```

```text
uv run ruff check src tests
```

Result:

```text
All checks passed!
```

```text
uv run mypy
```

Result:

```text
Success: no issues found in 241 source files
```

## Secret Handling

The unit and CLI tests cover secret non-disclosure:

- `test_doctor_service_reports_local_runtime_health_without_leaking_secrets`
- `test_main_runs_doctor_without_leaking_api_key`

The rendered real command reports only `api_key: present`.

## Conclusion

The doctor diagnostics acceptance criteria are satisfied. No additional doctor
code changes are needed in this closeout pass.

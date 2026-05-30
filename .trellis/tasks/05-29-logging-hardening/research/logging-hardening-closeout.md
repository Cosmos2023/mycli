# Logging Hardening Closeout

## Scope

- Date: 2026-05-30
- Workspace: `/Users/cosmos/Desktop/mycli`
- Task: `.trellis/tasks/05-29-logging-hardening`
- Status before closeout: `in_progress`

## Acceptance Mapping

- Runtime logs use user-home layout:
  - `~/.mycli/logs/agent.log`
  - `~/.mycli/logs/errors.log`
  - `~/.mycli/logs/model-events.jsonl`
  - `~/.mycli/logs/model-raw/<session-id>/...json`
- Compatibility callers that instantiate `WorkspaceLogService(workspace_root=...)`
  still use `<workspace_root>/log`.
- `WorkspaceLogService.set_session_id()` updates the visible log tag and raw
  payload bucket.
- Warning/error operational entries are written to `errors.log`; info/warning/error
  entries are written to `agent.log`.
- `/logs` is present in REPL help and command routing.
- Text logs and nested raw JSON payloads are redacted before disk persistence.

## Verification

```text
uv run mycli doctor
```

Result:

```text
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

## Relevant Real-Smoke Evidence

The lifecycle smoke task also verified the logging runtime path with real
provider calls:

- `~/.mycli/logs/agent.log` contained active session tags.
- `~/.mycli/logs/model-events.jsonl` contained redacted model events.
- `~/.mycli/logs/model-raw/lifecycle-branch-20260530220353/` received payloads
  after `/fork` and `/resume`.
- Raw/log/trace scans did not show `sk-...`, `Bearer ...`, or `api_key`
  patterns in the inspected evidence.

See:

```text
.trellis/tasks/archive/2026-05/05-30-session-resume-compaction-lifecycle-smoke/research/session-lifecycle-smoke-report.md
```

## Conclusion

The logging hardening acceptance criteria are satisfied. No additional logging
code changes are needed in this closeout pass.

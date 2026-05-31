# Session Orphan Cleanup Apply

## Problem

`mycli doctor` can detect orphan child rows in the session DB, but the local
agent foundation still lacks an explicit maintenance command to remove those
rows. A mature local agent should make corrupted/legacy storage both
diagnosable and maintainable without hiding destructive behavior behind a
default command.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Session / State parity by adding explicit orphan child-row
cleanup to session maintenance.

## Requirements

- Add a store-level orphan cleanup operation that:
  - scans known session child tables
  - deletes rows whose `session_id` has no matching `sessions.session_id`
  - returns per-table deleted row counts
  - does not delete `sessions` rows
  - does not repair lineage parent references
  - does not run `VACUUM`
- Add service formatting for bounded `key=value` output.
- Add CLI slash command `/session-maintenance --apply-orphans`.
- Include the new command in help, completion, and Node TUI slash discovery.
- Keep default `/session-maintenance` read-only.
- Keep `/session-maintenance --apply-empty` behavior unchanged.

## Acceptance Criteria

- Store unit tests prove:
  - orphan child rows are deleted from multiple child tables
  - valid session rows and valid child rows remain
  - empty-session cleanup remains separate
- Service/CLI tests prove `/session-maintenance --apply-orphans` output is
  routed and formatted.
- Node gateway command discovery includes the new slash command.
- Focused checks pass:
  - `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py tests/unit/cli/test_main.py tests/unit/cli/test_tui_completion.py tests/unit/cli/node_tui/test_gateway.py -q`
  - `uv run ruff check src/mycli/domain/session_store.py src/mycli/infrastructure/sqlite_session_store.py src/mycli/state/session_service.py src/mycli/application/turn_service.py src/mycli/cli/repl.py src/mycli/cli/tui/completion.py src/mycli/cli/node_tui/gateway.py tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py tests/unit/cli/test_main.py tests/unit/cli/test_tui_completion.py tests/unit/cli/node_tui/test_gateway.py`
  - `uv run mypy src/mycli/domain/session_store.py src/mycli/infrastructure/sqlite_session_store.py src/mycli/state/session_service.py src/mycli/application/turn_service.py src/mycli/cli/repl.py src/mycli/cli/tui/completion.py src/mycli/cli/node_tui/gateway.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No automatic cleanup from doctor.
- No lineage parent repair.
- No `VACUUM`.
- No background scheduler.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.

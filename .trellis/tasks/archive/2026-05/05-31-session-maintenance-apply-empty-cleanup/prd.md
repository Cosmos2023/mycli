# Session Maintenance Apply Empty Cleanup

## Problem

`mycli` can report empty session cleanup candidates, and doctor can point users
to `/session-maintenance`, but there is no safe apply path. A mature local agent
foundation should provide a bounded cleanup operation instead of forcing manual
SQLite edits.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Session / State parity by adding a safe, test-backed session
maintenance apply operation for empty sessions.

## Requirements

- Keep `/session-maintenance` as read-only dry-run by default.
- Add an explicit apply form: `/session-maintenance --apply-empty`.
- Apply must be workspace-scoped.
- Apply must recompute cleanup candidates at execution time.
- Apply must delete only sessions that still have no:
  - conversation messages
  - session summaries
  - history items
  - turn rollouts
  - session state
- Apply must not delete sessions that are present in `conversation_trees` as a
  parent or child. Lineage participation should require an explicit future
  pruning policy.
- Apply should support the same bounded candidate limit used by the dry-run
  report.
- Apply result must include:
  - `dry_run=false`
  - `deleted_empty_sessions=<count>`
  - `deleted_session=<id>` for each deleted session
  - `empty_sessions_remaining=<count>`
  - DB page/freelist/size metrics after cleanup
- Service/domain APIs must expose a structured result, not string parsing.

## Acceptance Criteria

- Unit tests cover:
  - deleting workspace-scoped empty sessions
  - preserving sessions with runtime state/history/rollouts/summaries/messages
  - preserving empty sessions involved in lineage
  - bounded apply limit and remaining count
  - CLI `/session-maintenance --apply-empty` output
- Existing session maintenance dry-run tests still pass.
- Focused tests pass:
  - `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py tests/unit/cli/test_main.py -q`
  - `uv run ruff check src/mycli/infrastructure/sqlite_session_store.py src/mycli/state/session_service.py src/mycli/application/turn_service.py src/mycli/cli/repl.py tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py tests/unit/cli/test_main.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No automatic cleanup from doctor.
- No vacuum execution in this slice.
- No deletion of lineage sessions.
- No cleanup of non-empty or corrupted sessions.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.

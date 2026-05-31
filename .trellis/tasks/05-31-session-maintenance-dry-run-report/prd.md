# PRD: Session Maintenance Dry Run Report

## Objective

Add a read-only session maintenance report so mycli can diagnose local session storage cleanup signals before adding destructive prune/vacuum/orphan cleanup behavior.

This is part of Hermes-like Session / State parity. It must produce concrete behavior, not just discovery.

## Scope

Implement:

- A typed domain report for session maintenance statistics.
- A read-only SQLite store method that reports:
  - total sessions scoped to the current workspace
  - empty sessions scoped to the current workspace, where empty means no conversation messages and no summaries
  - SQLite database file size in bytes
  - SQLite `page_count`, `freelist_count`, and `page_size`
  - explicit `dry_run=true`
- Service/application formatting for a slash-command style inspection.
- A CLI slash command for the report.
- Unit tests across infrastructure, service/application, and CLI command routing.

Do not implement:

- deletion/pruning
- `VACUUM`
- automatic repair
- session DB migration changes
- MCP/skills/subagent/ACP productization

## User-Facing Behavior

`/session-maintenance` returns bounded lines similar to:

```text
[session] dry_run=true
[session] workspace_sessions=2
[session] empty_sessions=1
[session] db_size_bytes=4096
[session] page_count=12
[session] freelist_count=0
[session] page_size=4096
```

The command is read-only and suitable for real smoke tests.

## Acceptance Criteria

- Store report is scoped by `workspace_root` for session counts.
- Empty sessions count only sessions with zero `conversation_messages` and zero `session_summaries`.
- SQLite storage counters are gathered read-only.
- CLI `/help` and completion list include `/session-maintenance`.
- Focused tests pass:
  - `tests/unit/infrastructure/test_sqlite_session_store.py`
  - `tests/unit/services/test_session_service.py`
  - `tests/unit/cli/test_main.py`
- Ruff passes for changed Python files.

## Risks

- SQLite file size can vary by platform and page allocation. Tests should assert non-negative/positive shape rather than exact byte size.
- This first slice intentionally does not remove orphaned rows or compact storage; it only makes those future actions diagnosable.

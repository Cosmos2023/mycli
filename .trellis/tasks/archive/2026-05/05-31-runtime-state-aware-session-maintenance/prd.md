# Runtime State Aware Session Maintenance

## Problem

Session maintenance currently treats a session as empty when it has no legacy
`conversation_messages` and no `session_summaries`. That misses runtime-native
state stored in `history_items`, `turn_rollouts`, and `session_state`, so a
session with resumable waiting state can be reported as an empty cleanup
candidate.

## Goal

Make session maintenance and doctor maintenance warnings respect runtime state
tables, so dry-run cleanup diagnostics do not classify resumable runtime
sessions as empty.

## Scope

- Update `SQLiteSessionStore.session_maintenance_report()` empty-session count
  and candidate query.
- Update doctor's read-only session maintenance check to use the same
  runtime-state-aware emptiness rule.
- Update `/session-maintenance` formatting only as needed by the report data.
- Add regression tests for sessions that contain only:
  - `history_items`
  - `turn_rollouts`
  - `session_state`
- Record the maintenance rule in backend DB/quality specs.

## Non-Goals

- No destructive cleanup command.
- No VACUUM execution.
- No schema migration.
- No TUI UX changes.
- No merge to `main`.

## Acceptance

- Store maintenance report does not count runtime-only sessions as empty.
- Doctor `session_maintenance` does not warn for runtime-only sessions.
- Truly empty sessions remain counted and listed as candidates.
- Existing session maintenance tests continue passing.

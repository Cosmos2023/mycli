# Current State

## Existing Behavior

- `mycli doctor` detects legacy/corrupt child rows whose `session_id` has no
  matching `sessions` row and reports `sessions_db=failed`.
- `/session-maintenance` is read-only by default and reports empty-session
  candidates, page counters, and bounded candidate details.
- `/session-maintenance --apply-empty` safely deletes only workspace-scoped
  empty sessions that have no messages, summaries, history, rollouts, state, or
  lineage participation.

## Gap

Doctor can detect orphan child rows, but the user has no explicit maintenance
command to clean them up after inspecting the failure. This leaves long-running
session storage diagnosable but not maintainable for a common legacy/corruption
case.

## Chosen Slice

Add an explicit `/session-maintenance --apply-orphans` operation that deletes
only child-table rows whose `session_id` is absent from `sessions`.

Safety boundaries:

- Default `/session-maintenance` remains read-only.
- Orphan cleanup is explicit and separate from empty-session cleanup.
- The operation must not delete rows from `sessions`, must not repair lineage
  parent references, and must not run `VACUUM`.
- Output must be bounded and machine-readable `key=value` lines.

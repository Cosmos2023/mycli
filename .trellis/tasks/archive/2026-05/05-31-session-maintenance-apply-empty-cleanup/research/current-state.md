# Current State

## Existing Behavior

- `SQLiteSessionStore.session_maintenance_report(...)` reports empty session
  candidates for a workspace.
- Empty means no conversation messages, summaries, history items, turn
  rollouts, or session state.
- Runtime-only sessions are already protected from empty classification.
- `SessionService.inspect_session_maintenance()` and `/session-maintenance`
  expose this as a dry-run report.
- `mycli doctor` warns when maintenance candidates exist and points users to
  `/session-maintenance`.

## Gap

The system can identify cleanup candidates but cannot safely apply cleanup
through a bounded, testable service path. That leaves Session / State parity
weaker than the target durable-agent foundation because users can inspect stale
empty session rows but not clean them without manual SQLite edits.

## Chosen Slice

Add an explicit empty-session cleanup operation that:

- Recomputes candidates at apply time instead of trusting client-provided ids.
- Deletes only sessions that still satisfy the same empty-session invariant.
- Is workspace-scoped.
- Returns a structured result with deleted ids, candidate count, omitted count,
  and DB page/freelist metrics.
- Leaves default `/session-maintenance` as read-only dry-run.

## Safety Boundaries

- Do not delete sessions with any conversation messages, summaries, history
  items, turn rollouts, or session state.
- Do not delete sessions outside the active workspace.
- Do not delete sessions that participate in conversation lineage.
- Do not auto-vacuum by default; expose existing page/freelist metrics so a
  future vacuum slice can be explicit.

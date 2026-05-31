# Runtime State Aware Session Maintenance Research

## Current State

- `/session-maintenance` and doctor `session_maintenance` are dry-run only.
- Empty-session detection currently checks `conversation_messages` and
  `session_summaries`.
- Runtime-native sessions may have no legacy conversation messages while still
  holding durable state in `history_items`, `turn_rollouts`, or `session_state`.
- Waiting approval and waiting clarification recovery depend on `session_state`
  plus rollout/history evidence.

## Gap

The maintenance dry-run can mark runtime-only sessions as empty. That is unsafe
for Hermes-like foundation work because a future cleanup command could delete a
session that is resumable only through runtime history/state tables.

## Direction

Make maintenance empty-session detection runtime-state aware:

- Count a session as empty only when it has no conversation messages, no
  summaries, no history items, no turn rollouts, and no session state rows.
- Apply the same rule to candidate listing and doctor maintenance warnings.
- Keep the behavior dry-run; do not add destructive cleanup.

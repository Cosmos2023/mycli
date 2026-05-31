# Runtime Interrupted Turn Diagnostics Research

## Current State

- The Node TUI gateway accepts `turn.interrupt` and emits `turn.status(state=interrupted)` while a worker is running.
- Runtime `TurnExecutor._finalize_interrupted_turn()` persists model continuation state, saves suspended turn state, appends a warning item, and finalizes the turn as `TurnStatus.INTERRUPTED` / `StopReason.INTERRUPTED`.
- There is no local trace/log event that explicitly records that an interrupted turn was saved for recovery.

## Gap

Hermes-like terminal turn status needs local diagnostics that explain why a turn ended as interrupted and where recovery state was preserved. TUI status alone is not enough for post-hoc debugging.

## Design Direction

Add a local-only `turn_interrupted` runtime trace/log diagnostic from `_finalize_interrupted_turn()` with bounded fields:

- `session_id`
- `turn_id`
- `stop_reason`
- `suspend_reason`
- `saved_state`
- `message_count`

This must not change provider-visible transcript content or request-shape inputs.

## Relevant Specs

- `.trellis/spec/backend/runtime-tui-gateway-contract.md`
- `.trellis/spec/backend/logging-guidelines.md`
- `.trellis/spec/backend/quality-guidelines.md`

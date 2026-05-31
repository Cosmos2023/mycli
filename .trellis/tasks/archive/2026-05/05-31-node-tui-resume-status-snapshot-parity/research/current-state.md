# Current State: Resume Status Snapshot Parity

## Finding

`session.resume` changes the active service session and emits `session.changed`,
but it does not immediately emit a fresh `status.changed` snapshot for the new
session. The Node reducer already relies on `status.changed.pending_decision ===
false` to clear stale approval state, but it does not clear stale clarification
state from `status.changed.suspended_turn === false`.

This means a TUI or extension client can resume from a session with waiting
approval or clarification into another session and keep stale local pending
state until another terminal event arrives.

## Contract Context

The runtime contract says:

- `session.changed` identifies the active session id after `/resume`, `/fork`, or
  `session.resume`.
- `status.changed` is the snapshot surface with `pending_decision` and
  `suspended_turn` booleans.
- Node reducer pending state should be driven by explicit request events and
  cleared by terminal events or status snapshots.

## Proposed Slice

- Emit `status.changed` immediately after gateway `session.resume` emits
  `session.changed`.
- Teach the reducer to clear `pendingClarification` when
  `status.changed.suspended_turn === false`.
- Add Python gateway and Node reducer tests so stale pending state cannot drift
  across resumed sessions.

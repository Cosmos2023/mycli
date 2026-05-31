# Status Changed Payload Contract Current State

## Current Behavior

- `NodeTuiGateway._status_payload()` emits `status.changed` with:
  - `session_id`
  - `workspace`
  - `model`
  - `provider`
  - `context_window`
  - `pending_decision`
  - `suspended_turn`
- `session.resume` emits `session.changed`, then `status.changed`, then any
  pending `approval.request` / `clarify.request` payload for the resolved tip.
- Node reducer consumes `status.changed` to update session status, context
  window, and stale pending state.

## Gap

The Python runtime manifest and TypeScript protocol contract currently expose
`status.changed` as an event with an empty payload schema. That makes the
event discoverable by name but not usable as a stable machine contract.

This is a drift risk because `status.changed` is now part of resume recovery:
clients need to know which fields are stable and which nested fields exist.

## Proposed Slice

- Add a real `status.changed` payload schema in
  `mycli.domain.runtime.gateway_contract`.
- Mirror the same required fields/properties in
  `tui/node/src/protocol/types.ts`.
- Add focused Python schema tests for the status payload.
- Rely on the existing Node manifest parity test to catch TS/Python drift.
- Update the runtime TUI gateway contract prose.

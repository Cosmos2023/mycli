# Node TUI Turn Status Consumption

## Goal

Teach the Node TUI reducer to consume the new Hermes-like `turn.status`
runtime event as a first-class status source while preserving current visible
rendering and compatibility behavior.

## Context

- The Python gateway now emits normalized `turn.status` events for completed,
  waiting-approval, failed, interrupted, and approval-resolution paths.
- The Node reducer currently derives live turn state from `status.update`,
  `turn.completed`, and `turn.failed`.
- `runtime.event` already unwraps into direct reducer event handling, so
  `turn.status` support should work both directly and through the envelope.
- This slice should not add transcript rows or change TUI layout. It only makes
  the reducer understand the new contract.

## Research References

- [`research/node-tui-turn-status-consumption.md`](research/node-tui-turn-status-consumption.md)
  summarizes the reducer path and recommends mapping `turn.status` into
  existing live-status state.

## Requirements

- Add a TypeScript payload type for `turn.status`.
- Update the Node reducer to consume direct `turn.status` events.
- `turn.status` must update:
  - `liveStatus`
  - `turnRunning`
  - `currentTurnId`
  - `liveReasoning`
  - `typedMessageTurnId`
  - `pendingApproval`
- `turn.status(state=waiting_approval, terminal=false)` must keep
  `turnRunning=true` and preserve the pending approval prompt.
- Terminal `turn.status` states (`completed`, `failed`, `interrupted`) must set
  `turnRunning=false`, clear `liveReasoning`, clear `typedMessageTurnId`, and
  clear `pendingApproval`.
- Invalid `turn.status` states must be ignored.
- Do not append transcript rows from `turn.status`; `turn.completed` and
  `turn.failed` remain responsible for final answer/error transcript changes.
- `runtime.event` wrapping `turn.status` must work through the existing unwrap
  path.

## Non-Goals

- Do not change visible TUI layout, colors, copy, or RunningActivity rendering.
- Do not remove `status.update`, `turn.completed`, or `turn.failed` reducer
  paths.
- Do not implement a dedup transport preference.
- Do not change Python gateway behavior in this slice.
- Do not merge into `main`.

## Acceptance Criteria

- Reducer test proves direct `turn.status` updates waiting approval state and
  preserves pending approval.
- Reducer test proves direct terminal `turn.status` clears running state and
  live reasoning without appending transcript rows.
- Reducer test proves invalid `turn.status` payload is ignored.
- Reducer test proves `runtime.event` wrapping `turn.status` reaches the same
  reducer path.
- Node focused tests pass.
- Node type-check passes when dependencies are available; if dependencies are
  missing, dependency verification must fail with actionable output.
- Trellis task is archived and work is committed only on
  `feature/mycli-tui-turn-status-consumption`.

# Terminal Turn Status Runtime Contract

## Goal

Add a normalized Hermes-like `turn.status` runtime event so clients can
subscribe to a single terminal/waiting turn-status channel instead of deriving
turn outcomes from `turn.completed`, `turn.failed`, `turn.interrupted`, and
`status.update` separately.

## Context

- The gateway already emits `turn.completed`, `turn.failed`,
  `turn.interrupted`, and `status.update`.
- `turn.completed` carries `turn_state`, but failed and interrupted paths use
  different payload shapes.
- Future TUI, extension, ACP, MCP, and diagnostic consumers need one small
  payload shape for turn outcome routing.
- Current Node TUI rendering should remain compatible and keep consuming the
  existing events.

## Research References

- [`research/terminal-turn-status-contract.md`](research/terminal-turn-status-contract.md)
  documents the current event split and recommends a mirrored normalized event.

## Requirements

- Add a `turn.status` gateway notification for terminal/waiting turn state
  transitions.
- Payload fields:
  - `client_turn_id`: optional string when known
  - `state`: one of `waiting_approval`, `completed`, `failed`, `interrupted`
  - `kind`: renderable status kind, normally same as `state`
  - `text`: short human-readable status
  - `terminal`: boolean; true for `completed`, `failed`, and `interrupted`,
    false for `waiting_approval`
  - `message`: optional failure/interruption detail
- Preserve existing event behavior:
  - keep `turn.completed`, `turn.failed`, `turn.interrupted`, and
    `status.update`
  - keep `runtime.event` mirrors for all events emitted through `_emit_event`
  - do not remove or rename existing payload fields
- Emit `turn.status` for:
  - successful completed turns
  - turns that enter `waiting_approval`
  - failed user turns
  - failed approval-resolution turns
  - user interruption requests while a turn is running
  - completed approval-resolution turns
- Keep real cancellation semantics out of scope. The existing interrupt request
  marks UI status but does not stop the worker thread.

## Non-Goals

- Do not change visible Node TUI rendering in this slice.
- Do not implement true cooperative cancellation.
- Do not remove existing method-name notifications.
- Do not change session persistence or runtime ledger semantics.
- Do not implement ACP, MCP, extension, or subagent consumers.
- Do not merge into `main`.

## Acceptance Criteria

- Gateway unit tests prove `turn.status` is emitted for completed,
  waiting-approval, failed, interrupted, and approval-resolution flows.
- Gateway tests prove existing events are still emitted in compatible order.
- `runtime.event` mirror tests continue to pass and include the new event.
- Runtime TUI gateway spec documents the `turn.status` payload and sequencing.
- Focused Python gateway tests pass.
- Python lint and type-check pass for touched files.
- Trellis task is archived and work is committed only on
  `feature/mycli-terminal-turn-status-contract`.

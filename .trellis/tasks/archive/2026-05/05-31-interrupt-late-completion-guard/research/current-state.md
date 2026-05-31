# Interrupt Late Completion Current State

## Scope

This slice covers the runtime/TUI race where a user requests `turn.interrupt`
while the Python turn worker is still running, but the worker later returns a
normal completed `TurnResponse`.

## Current Data Flow

`turn.submit` starts a background worker in `NodeTuiGateway._run_turn_worker`
and stores:

- `_turn_running = True`
- `_current_client_turn_id = <client turn id>`
- `_interrupt_requested = False`

`turn.interrupt` currently:

- sets `_interrupt_requested = True` while the turn is still running
- records a local interrupt diagnostic through
  `record_turn_interrupt_request(client_turn_id=...)`
- emits `turn.interrupted`
- emits `turn.status(state=interrupted, terminal=true)`
- emits `status.update(state=interrupted)`

When the worker later returns, `_run_turn_worker` still emits the normal success
path:

- optional `approval.request`
- `turn.completed`
- `turn.status(state=completed|waiting_approval|...)`
- final `message.complete(final=true)` for completed turns
- `status.update(state=completed|...)`

The Node reducer also accepts `turn.completed`, final `message.complete`, and
`status.update(completed)` for the same `client_turn_id` after it has already
entered `interrupted`.

## Gap

An accepted interrupt is currently diagnosable, but it is not terminally
authoritative at the gateway/TUI boundary. A late normal completion can overwrite
the interrupted state and can add a final assistant answer that the user did not
ask to keep after interrupting.

## Desired Contract

For the running-turn submit path:

- Once an interrupt is accepted for the current `client_turn_id`, a later normal
  completed response for that same turn must not emit terminal completion events
  that supersede `interrupted`.
- The gateway should emit a bounded local event that explains the suppressed
  late completion. It is a runtime/gateway diagnostic event, not model-visible
  transcript content.
- Node should defensively ignore stale completed/final-complete/completed-status
  events for a turn whose live status is already terminal interrupted.

## Relevant Specs

- `.trellis/spec/backend/runtime-tui-gateway-contract.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`

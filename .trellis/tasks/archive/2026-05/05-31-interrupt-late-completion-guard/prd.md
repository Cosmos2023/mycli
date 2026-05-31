# Guard Late Completions After Interrupt

## Problem

`turn.interrupt` currently records and emits an interrupted state, but the active
turn worker can still return a normal completed response. When that happens, the
gateway and Node reducer can overwrite the interrupted state with completed
state and final assistant text.

For Hermes-like runtime/TUI parity, an accepted user interrupt must be terminal
for that client turn at the gateway contract boundary unless a future cooperative
cancellation API explicitly reports a different outcome.

## Goals

- Preserve `interrupted` as the terminal runtime/TUI state after an accepted
  running-turn interrupt.
- Suppress late normal completion events for the interrupted `client_turn_id`.
- Keep the behavior diagnosable with a bounded event/trace surface.
- Defensively prevent Node TUI state regression if a stale completion event is
  received from older or buggy gateways.

## Non-Goals

- Do not implement provider-level cancellation.
- Do not productize ACP/MCP/skills/subagents.
- Do not change approval or clarification continuation semantics outside the
  interrupted running-turn submit path.
- Do not copy Hermes code.

## Requirements

1. If `turn.interrupt` is accepted while a turn is running, the gateway must keep
   the client turn terminal state as `interrupted`.
2. If the interrupted worker later returns a completed `TurnResponse` with no
   pending decision/clarification, the gateway must not emit:
   - `turn.completed`
   - `turn.status(state=completed)`
   - final `message.complete(final=true)`
   - `status.update(state=completed)`
3. The gateway must emit a bounded diagnostic notification for the suppressed
   late completion, including the `client_turn_id`, without raw user message,
   provider payload, tool output, headers, or secrets.
4. Node reducer must ignore stale `turn.completed`, final
   `message.complete(final=true)`, and completed `status.update` for a
   `client_turn_id` whose live status is already `interrupted`.
5. The runtime TUI gateway contract spec must document the stronger interrupted
   terminal guarantee and diagnostic event.
6. Tests must cover:
   - Python gateway unit behavior for a blocked turn interrupted before normal
     return.
   - Node reducer stale completion defense.
   - Real Node scripted smoke preserving interrupted state when the service
     returns a normal answer after the interrupt.

## Acceptance

- Focused Python gateway test fails before implementation and passes after.
- Focused Node reducer test fails before implementation and passes after.
- Integration scripted Node smoke verifies final state remains interrupted and
  no late final answer is appended.
- Full Python tests pass.
- Node TUI tests and typecheck pass.

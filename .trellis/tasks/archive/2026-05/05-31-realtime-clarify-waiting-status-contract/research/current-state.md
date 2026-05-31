# Current State: Realtime Clarification Waiting Status

## Finding

`NodeTuiGateway._forward_stream_event()` forwards a runtime
`clarify_request` stream event as a `clarify.request` notification and mirrors
it through `runtime.event`.

The gateway currently emits the normalized `turn.status` and `status.update`
waiting states only after the worker returns a `TurnResponse` and
`turn.completed` is emitted. This means a TUI client receives the actual
clarification request before it receives the status transition that says the
turn is waiting for clarification.

Approval has an explicit waiting status on the terminal response path, and the
contract already defines `waiting_clarification` as a first-class state. The
missing realtime status makes clarification less Hermes-like because clients
cannot render "waiting for user input" immediately from the request event.

## Desired Coverage

Add gateway-level coverage proving that a `clarify.request` stream event emits:

1. `clarify.request`
2. `turn.status(state=waiting_clarification, terminal=false)`
3. `status.update(state=waiting_clarification)`

The final `turn.completed` compatibility event should remain unchanged and the
gateway must still avoid final `message.complete` for waiting clarification
turns.

# Current State: Legacy `turn.event` Protocol Parity

## Finding

Python advertises `turn.event` as a supported gateway event stream in
`src/mycli/domain/runtime/gateway_contract.py`, and the Node TUI reducer still
consumes `turn.event` as a compatibility fallback for assistant deltas and
legacy tool-call rows.

The TypeScript protocol union in `tui/node/src/protocol/types.ts` does not list
`turn.event` in `KnownGatewayEvent`. That means typed clients treat an advertised
and reducer-supported compatibility event as an unknown event.

## Evidence

- `SUPPORTED_GATEWAY_EVENT_STREAMS` includes `turn.event`.
- `ExtensionManifestService` builds manifest `event_streams` from that constant.
- `NodeTuiGateway._forward_stream_event()` emits typed events and then emits
  compatibility `turn.event`.
- `reduceShellState()` handles `turn.event` with `phase=assistant_delta` and
  `phase=tool_call`.
- `KnownGatewayEvent` lacks `Notification<"turn.event", ...>`.

## Implication

The runtime contract is not fully aligned across Python manifest, Python
gateway, TypeScript protocol typing, and TypeScript reducer. This is a small
but concrete runtime contract parity gap.

## Desired Change

Add a bounded `TurnEventPayload` type and include `turn.event` in
`KnownGatewayEvent`. Add tests proving typed clients can narrow `turn.event` and
that the Python manifest advertised event set is represented in the TypeScript
known-event union.

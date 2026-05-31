# Runtime Event Envelope Contract

## Goal

Introduce a Hermes-like versioned runtime event envelope as a compatibility
mirror for the existing runtime-to-Node-TUI JSON-RPC notifications. This gives
future TUI, extension, ACP, and external client work one stable event stream
shape without breaking the current method-name notification contract.

## Context

- Current gateway notifications use the event type as the JSON-RPC method:
  `message.delta`, `reasoning.delta`, `tool.start`, `turn.completed`, and so on.
- The Node TUI reducer already consumes those method names directly.
- The existing runtime TUI contract explicitly keeps method-name notifications
  compatible until a versioned envelope migration is introduced.
- Hermes-like parity benefits from clear channel separation and typed event
  envelopes, but mycli should evolve incrementally.

## Research References

- [`research/runtime-event-envelope-contract.md`](research/runtime-event-envelope-contract.md)
  — recommends adding a mirrored `runtime.event` envelope while preserving all
  existing notifications.

## Requirements

- Add a `runtime.event` JSON-RPC notification mirror for runtime events emitted
  through `NodeTuiGateway._emit_event(...)`.
- Preserve every existing method-name notification exactly as-is.
- Envelope payload must include:
  - `version`: `1`
  - `sequence`: monotonically increasing integer per gateway instance
  - `type`: original notification method, for example `message.delta`
  - `payload`: original params object
  - `timestamp`: UNIX timestamp seconds from the gateway process
- `runtime.event` must not recursively wrap itself.
- `runtime.ready` bootstrap emission should remain outside the envelope in this
  slice because it is emitted before gateway event sequencing starts.
- Node reducer should be able to consume a `runtime.event` envelope by unwrapping
  `type` and `payload` and reusing the existing reducer behavior.
- The real Node TUI should not change visible rendering behavior in this slice.
- Update the runtime TUI gateway contract spec to document the envelope.

## Non-Goals

- Do not remove or rename existing gateway notifications.
- Do not require the Node client to prefer envelope transport yet.
- Do not implement ACP, extension, MCP, or multi-agent integration.
- Do not change model/runtime provider transcript data.
- Do not copy Hermes implementation code.
- Do not merge into `main`.

## Acceptance Criteria

- Gateway unit test proves normal events still emit existing method-name
  notifications.
- Gateway unit test proves `runtime.event` mirrors typed runtime events with
  `version`, `sequence`, `type`, `payload`, and `timestamp`.
- Gateway unit test proves envelope sequence numbers are monotonic for a turn.
- Gateway unit test proves envelope emission does not recurse.
- Node reducer unit test proves a `runtime.event` envelope can drive the same
  state transition as the direct event.
- Python lint/type-check/focused gateway tests pass.
- Node reducer/protocol typecheck and focused tests pass if TypeScript changes
  are made.
- Trellis task is archived and the work is committed only on
  `feature/mycli-runtime-event-envelope`.

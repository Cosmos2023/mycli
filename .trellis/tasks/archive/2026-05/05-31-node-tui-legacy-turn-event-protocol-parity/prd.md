# Node TUI Legacy Turn Event Protocol Parity

## Problem

`turn.event` is still part of the gateway compatibility contract: Python emits
it, the extension manifest advertises it, and the Node TUI reducer consumes it
as a fallback while typed `message.*` and `tool.*` events are adopted.

However, `tui/node/src/protocol/types.ts` does not include `turn.event` in the
known event union. This leaves a contract gap where a manifest-advertised event
is typed as unknown by Node clients.

## Scope

In scope:

- Add a TypeScript payload type for compatibility `turn.event`.
- Include `turn.event` in `KnownGatewayEvent`.
- Add tests that catch drift between Python advertised event streams and the
  TypeScript known-event list.
- Keep reducer behavior unchanged except where type compatibility requires it.

Out of scope:

- Removing `turn.event`.
- Productizing extension/ACP/MCP/subagent features.
- Changing Python gateway emission order.
- Changing UI rendering semantics.

## Requirements

- TypeScript known-event methods must include every Python-advertised gateway
  event stream from `SUPPORTED_GATEWAY_EVENT_STREAMS`.
- `turn.event` payload must cover the compatibility fields emitted by Python:
  `client_turn_id`, `phase`, `kind`, `text`, `tool_name`, and `metadata`.
- Typed client tests must prove `waitForEvent("turn.event", ...)` narrows the
  payload enough to inspect `phase` and `text`.
- Existing reducer fallback tests for legacy `turn.event` must continue to pass.
- Node `npm test` and `npm run typecheck` must pass.

## Acceptance Criteria

- `tui/node/src/protocol/types.ts` exposes `turn.event` as a known event.
- A Node test compares the Python supported gateway event list to the TypeScript
  known-event list and fails if either side drifts.
- Focused Node protocol/client/reducer tests pass.
- Full Node TUI `npm test` and `npm run typecheck` pass.

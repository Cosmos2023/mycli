# Node TUI Request Error Feedback

## Background

The gateway now emits `gateway.error` for unexpected request-handler failures,
and the reducer can render that event. However, JSON-RPC request responses with
`error` still reject `GatewayClient.send(...)`. Several real TUI actions fire
those requests with `void client.send(...)` or `.then(...)` without a rejection
handler, so a normal request error can become an unhandled Promise rejection
instead of visible user feedback.

Hermes-like maturity requires both event-stream failures and direct request
failures to be visible, bounded, and recoverable in the TUI.

## Goals

- Route rejected Node TUI gateway requests into visible error transcript rows.
- Preserve existing successful request behavior.
- Preserve `gateway.error` event handling from the previous slice.
- Avoid duplicating error rows when a rejected request also produced a direct
  `gateway.error` event.
- Keep this as a Node TUI consumption-layer change; do not change Python
  gateway semantics or JSON-RPC wire format.

## Non-Goals

- Do not add retry/backoff behavior.
- Do not change gateway response codes or payload shape.
- Do not add logging files in this slice.
- Do not copy Hermes code.

## Acceptance Criteria

- `GatewayClient.send(...)` rejection exposes the JSON-RPC error code and
  message to callers.
- `RuntimeApp` dispatches a visible error row when bootstrap, transcript load,
  command, submit, approval, clarification, interrupt, or shutdown requests
  reject.
- A nearby `gateway.error` event plus rejected response for the same request
  does not create duplicate visible error rows.
- Existing command success and local command flows still work.
- Node typecheck and tests pass.

## Verification

- `npm --prefix tui/node run typecheck`
- `npm --prefix tui/node test`
- `git diff --check`

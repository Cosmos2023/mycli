# Scripted Approval Request Error Smoke Research

## Current State

- `RuntimeApp` wraps `GatewayClient.send()` and dispatches `request.failed`
  when a JSON-RPC request rejects.
- `GatewayClient` exposes `GatewayRequestError` with request `method`, `code`,
  and message.
- The reducer already renders request failures as a single error transcript row
  and deduplicates matching `gateway.error` events.
- The scripted client uses `client.send()` directly. If `approval.respond`
  rejects, the smoke process fails before dumping state, so scripted smoke
  cannot verify how request errors appear in TUI state.

## Gap

Hermes-like TUI gateway parity requires failed approval responses to be visible
to users. The main app has this path, but the real scripted smoke harness does
not exercise it and cannot persist the resulting TUI state.

## Direction

Teach the scripted client to route request failures through the same
`request.failed` reducer action used by `RuntimeApp`. Add an explicit scripted
action that sends `approval.respond` without requiring pending local approval
state, so the harness can exercise no-pending or wrong-decision failures.

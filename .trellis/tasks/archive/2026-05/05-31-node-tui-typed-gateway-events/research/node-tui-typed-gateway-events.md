# Node TUI Typed Gateway Events Research

## Existing Behavior

- `tui/node/src/protocol/types.ts` already defines payload types for approval,
  status, and terminal turn status.
- The exported `GatewayEvent` type is still just `RpcNotification`, so event
  consumers see `method: string` and `params: Record<string, unknown>`.
- The reducer remains intentionally defensive and validates payloads at runtime,
  but TypeScript cannot currently catch drift between documented gateway event
  names and Node-side event consumers.
- `runtime.event` already carries a typed envelope shape at the Python contract
  level, but the Node protocol type does not model that envelope.

## Recommended Slice

- Add TypeScript payload types for the currently implemented Hermes-like event
  channels:
  - `runtime.event`
  - `turn.started`
  - `status.update`
  - `approval.request`
  - `approval.respond`
  - `tool.start`
  - `tool.progress`
  - `tool.complete`
  - `tool.failed`
  - `message.delta`
  - `message.complete`
  - `reasoning.delta`
  - `thinking.delta`
  - `turn.completed`
  - `turn.failed`
  - `turn.interrupted`
  - `turn.status`
  - `status.changed`
- Define `KnownGatewayEvent` as a discriminated union over those method names.
- Keep `GatewayEvent = KnownGatewayEvent | UnknownGatewayEvent` so future or
  compatibility events still pass through the client.
- Do not force reducer payload handling to trust the types yet; keep runtime
  validation in place.

## Risks

- Making `GatewayEvent` only known events would break forward compatibility.
  - Mitigation: include `UnknownGatewayEvent`.
- Over-typing payloads too aggressively could require broad reducer rewrites.
  - Mitigation: this slice only types the protocol surface and client helpers.
- Modeling `runtime.event` payload too narrowly would block future events.
  - Mitigation: represent it as an envelope with `type: string` and generic
    payload, while still documenting current version/sequence/timestamp fields.

## Out Of Scope

- No Python changes.
- No transport migration.
- No reducer trust-based refactor.
- No ACP/extension implementation.

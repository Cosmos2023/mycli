# Node TUI Typed Gateway Events

## Goal

Move the Node TUI protocol layer closer to Hermes-like typed gateway contracts
by replacing the bare `GatewayEvent = RpcNotification` alias with a
discriminated event union for implemented runtime/TUI channels.

## Context

- mycli now emits and consumes separate channels for approval, status,
  tool lifecycle, message deltas, reasoning, runtime envelope mirrors, and
  terminal turn status.
- The Python/Trellis contract documents those channels, but Node TypeScript
  still treats all notifications as untyped method strings.
- Hermes-style maturity depends on stable typed event surfaces so future TUI,
  extension, ACP, MCP, and subagent consumers can evolve without silent drift.

## Research References

- [`research/node-tui-typed-gateway-events.md`](research/node-tui-typed-gateway-events.md)
  documents the existing protocol type gap and compatibility plan.

## Requirements

- Add TypeScript payload types for current known gateway notifications:
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
- Define `KnownGatewayEvent` as a discriminated union by `method`.
- Preserve forward compatibility with `UnknownGatewayEvent`.
- Keep `GatewayEvent` usable by the existing `GatewayClient` without changing
  runtime behavior.
- Keep reducer runtime validation intact.
- Add type-level or lightweight runtime tests proving known events can be
  consumed through `GatewayClient.waitForEvent(...)`.
- Do not merge into `main`.

## Non-Goals

- Do not change Python gateway emission.
- Do not remove compatibility `turn.event`.
- Do not migrate to Hermes' exact envelope transport.
- Do not implement ACP/extension consumers.

## Acceptance Criteria

- `GatewayEvent` is no longer a plain `RpcNotification` alias.
- Known event methods narrow their `params` payload type in TypeScript.
- Unknown notifications remain accepted by `GatewayClient`.
- Node typecheck passes.
- Focused protocol/client tests pass.
- Trellis task is archived and work is committed only on
  `feature/mycli-node-tui-typed-gateway-events`.

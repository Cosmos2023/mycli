# Extension Event Stream Parity

## Problem

`extension.manifest` advertises gateway event streams for external and future
extension clients. RPC method parity is now guarded, but event streams are still
only a static manifest list with no gateway-owned supported set.

Hermes-like gateway contracts depend on truthful channel discovery: clients
should be able to trust that advertised event streams are real gateway
notifications.

## Goal

Add an event-stream parity guard that keeps extension manifest event stream
entries aligned with the Node TUI gateway's supported notification surface.

## Scope

- Add a gateway-owned supported event stream set or helper.
- Add a unit test proving manifest `event_streams[].name` is a subset of the
  gateway-supported notification methods.
- Keep existing event names and semantics unchanged.
- Preserve `extension.manifest` as a read-only discovery surface.

## Requirements

- Manifest event stream names must not advertise unsupported gateway
  notifications.
- The parity guard must cover existing Hermes-like channels such as
  `status.update`, `approval.request`, `approval.respond`, `turn.event`,
  `turn.completed`, `turn.failed`, and `turn.interrupted`.
- `status.changed` and `turn.started` may be gateway notifications, but they
  are compatibility/internal bootstrap notifications unless explicitly added to
  the manifest later.
- No new extension lifecycle, ACP, or MCP capability should be introduced.

## Non-Goals

- No event envelope redesign.
- No TypeScript reducer changes.
- No dynamic plugin/event subscription system.
- No merge to `main`.

## Acceptance

- Red/green test proves manifest event streams are gateway-supported.
- Existing extension manifest, gateway, `/extensions`, lint, type-check, and
  diff checks pass.

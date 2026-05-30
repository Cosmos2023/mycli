# Extension Capability Manifest

## Problem

mycli now exposes machine-readable runtime trace rows through `trace.export`,
but extension/ACP clients still have no stable way to discover what integration
surfaces exist. Without a capability manifest, every client has to hardcode
method names and feature assumptions.

## Goal

Expose a read-only extension capability manifest through service and gateway
layers.

## Scope

- Add a small extension capability service.
- Add `TurnService.extension_manifest()`.
- Add `extension.manifest` JSON-RPC method to the Node gateway.
- Document the gateway contract.
- Add service and gateway unit tests.

## Requirements

- Manifest is read-only.
- Manifest contains stable top-level fields:
  - `schema_version`
  - `agent`
  - `rpc_methods`
  - `event_streams`
  - `capabilities`
- It must include the newly available `trace.export` RPC.
- It should describe current integration families without promising plugin
  lifecycle support that does not exist yet.
- Gateway response must be the same manifest object produced by the service.

## Non-Goals

- No dynamic plugin loading.
- No ACP server.
- No extension installation.
- No network listener.
- No merge to `main`.

## Acceptance

- Service unit tests prove manifest shape and key capabilities.
- Gateway unit tests prove `extension.manifest` returns the manifest.
- Type, lint, and relevant gateway tests pass.

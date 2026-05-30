# Extension Manifest Gateway Parity

## Problem

`extension.manifest` is the discovery surface external clients use before they
call mycli's Node TUI gateway. The manifest currently lists the intended RPC
surface, but there is no test that proves every advertised RPC is actually
routable by the gateway.

For Hermes-like extension parity, discovery must be truthful. A stale manifest
is worse than no manifest because clients can confidently call unsupported
methods.

## Goal

Add a parity guard that keeps the extension manifest aligned with the gateway's
actual RPC method surface.

## Scope

- Add a gateway-facing test that every manifest `rpc_methods[].name` is handled
  by `NodeTuiGateway`.
- Keep `extension.manifest` read-only and truthful.
- Add any small helper needed to expose the gateway's routable method names
  without duplicating the handler list in tests.
- Do not add new RPC methods unless the gateway already supports them.

## Requirements

- The manifest's advertised RPC method names must be a subset of the gateway's
  supported request methods.
- The parity test must fail if a future manifest advertises an unsupported RPC.
- The manifest must continue to report `extensions.lifecycle` and `acp.server`
  as `not_available`.
- `/extensions` remains a human summary of the manifest and must not become raw
  JSON.

## Non-Goals

- No dynamic extension lifecycle.
- No ACP server.
- No MCP feature expansion.
- No merge to `main`.

## Acceptance

- Unit test covers manifest-to-gateway RPC parity.
- Existing extension manifest, gateway, and `/extensions` tests still pass.
- Relevant lint, type-check, and diff checks pass.

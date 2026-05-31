# Current State: Runtime Contract Schema Convergence

## Goal

Move the runtime/TUI contract from name-only discovery toward a machine-readable contract that can be consumed by the Node TUI, extension clients, and future ACP-style adapters.

## Existing Behavior

- `src/mycli/domain/runtime/gateway_contract.py` is the Python source of truth for supported RPC method names and event stream names.
- `src/mycli/services/extensions/manifest.py` exposes `extension.manifest` with described `rpc_methods`, `event_streams`, and capabilities.
- `mycli doctor` has a `runtime_contract` check that compares manifest RPC/event names against gateway-advertised sets.
- `tui/node/src/protocol/types.ts` defines TypeScript payload types and `KNOWN_GATEWAY_EVENT_METHODS`.
- `tui/node/test/client.test.ts` verifies TypeScript event names match Python `SUPPORTED_GATEWAY_EVENT_STREAMS`.

## Gap

The manifest only exposes event names and descriptions. It does not advertise payload shape, required fields, terminal-state semantics, or bounded diagnostic fields. This means external clients can discover that `turn.status` exists but cannot inspect its stable payload contract without reading prose docs or TypeScript source.

## Implementation Direction

- Add lightweight JSON-schema-like payload schemas for gateway event streams in Python runtime contract code.
- Include these schemas in `extension.manifest.event_streams`.
- Add doctor validation that all advertised event streams have object payload schemas and that schema names match supported event streams.
- Add focused tests for manifest schema presence and doctor mismatch detection.
- Keep this as foundation contract metadata only; do not add MCP, skills, subagent, or ACP product surfaces.

## Risks

- Full JSON Schema validation for every field would be too large for this slice and risks becoming busywork. The useful hardening step is to make payload schema discovery first-class and enforce that every supported event has a schema entry.
- Python and TypeScript schema generation from one source of truth is not implemented in this slice. A later slice can consume `extension.manifest` from Node tests if tighter cross-language validation is needed.

# Runtime Error Taxonomy Current State

## Surfaces

- Python runtime contract defines `GATEWAY_ERROR_CODES` in
  `src/mycli/domain/runtime/gateway_contract.py`.
- `gateway.error` event payload schema exposes those codes through
  `gateway_event_payload_schemas()`.
- Extension manifest includes event payload schemas, so manifest consumers can
  discover gateway error code enums indirectly.
- Node reducer and client tests assert several literal codes, but Node does not
  expose a central `GatewayErrorCode` taxonomy or verify it against the Python
  manifest.
- Runtime contract documentation lists gateway error codes inline.

## Gap

The Python side has a taxonomy, but the Node TUI client treats error codes as
ad-hoc strings. That leaves room for drift between Python contract/manifest and
TypeScript protocol/reducer behavior.

## Proposed Slice

- Add a TypeScript gateway error code taxonomy exported from the protocol layer.
- Verify it matches the Python manifest schema.
- Type request-failure and gateway-error reducer metadata with the stable code
  union while preserving unknown external strings only at the transport edge if
  necessary.
- Keep product scope to runtime/TUI foundation; do not productize MCP, skills,
  subagents, or ACP.

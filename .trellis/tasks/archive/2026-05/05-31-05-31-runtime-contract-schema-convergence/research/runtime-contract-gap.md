# Runtime Contract Schema Gap

Date: 2026-05-31

## Current Sources

- Python gateway constants:
  - `src/mycli/cli/node_tui/gateway.py::SUPPORTED_RPC_METHODS`
  - `src/mycli/cli/node_tui/gateway.py::SUPPORTED_EVENT_STREAMS`
- Extension discovery manifest:
  - `src/mycli/services/extensions/manifest.py`
- TypeScript gateway contract types:
  - `tui/node/src/protocol/types.ts`
- Reducer handling:
  - `tui/node/src/state/reducer.ts`
- Contract spec:
  - `.trellis/spec/backend/runtime-tui-gateway-contract.md`

## Findings

1. `ExtensionManifestService` hand-maintains RPC and event stream lists instead
   of deriving them from the Python gateway contract constants. Existing tests
   only assert the manifest is a subset of supported gateway methods/events, so
   omitted supported streams are not detected.
2. The manifest currently advertises only 9 RPC methods and 7 event streams,
   while the gateway supports more Hermes-like runtime events such as
   `runtime.event`, `message.delta`, `message.complete`, `reasoning.delta`,
   `thinking.delta`, `tool.start/progress/complete/failed`, `turn.status`,
   `gateway.error`, `clarify.request/respond`, and `status.changed`.
3. Python gateway emits `session.changed` from resume/fork command paths and
   `session.resume`, but `SUPPORTED_EVENT_STREAMS` does not include it.
4. Python gateway mirrors normal runtime notifications through `runtime.event`,
   but `SUPPORTED_EVENT_STREAMS` does not include `runtime.event`.
5. TypeScript `KnownGatewayEvent` does not include `session.changed`, although
   the reducer can still accept it as an unknown event. This weakens typed
   client/discovery parity.
6. Contract spec lists `runtime.event` and `session.changed` semantics in prose,
   but the Python supported stream constant and manifest do not fully match.

## First Slice

Make discovery and typed contract surfaces converge:

- Add missing gateway supported streams for `runtime.event` and
  `session.changed`.
- Build `ExtensionManifestService` RPC/event entries from the same gateway
  constants, while keeping descriptions local.
- Add TypeScript payload/type coverage for `session.changed`.
- Strengthen tests so manifest RPC/event names equal gateway constants, not just
  subset them.
- Update CLI extension count assertions and the runtime contract spec.

## Verification

- `uv run pytest tests/unit/services/test_extension_manifest.py tests/unit/cli/node_tui/test_gateway.py tests/unit/cli/test_main.py -q`
- `npm --prefix tui/node test`
- `npm --prefix tui/node run typecheck`

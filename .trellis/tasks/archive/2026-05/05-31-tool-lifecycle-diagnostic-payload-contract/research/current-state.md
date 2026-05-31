# Current State: Tool Lifecycle Diagnostic Payload Contract

## Finding

The backend runtime already emits lifecycle diagnostic metadata for
`tool.complete` and `tool.failed`:

- `summary_chars`
- `summary_truncated`
- `error_chars`
- `error_truncated`

`ToolExecutionService` unit tests cover the runtime-side metadata. Node
transcript tests also preserve these values when they arrive.

The cross-layer contract is weaker:

- `tui/node/src/protocol/types.ts` does not declare the diagnostic fields on
  `ToolCompletePayload` / `ToolFailedPayload`.
- Python gateway fake/smoke lifecycle payloads do not include the fields, so
  forwarding tests can pass even if diagnostic completeness is accidentally
  dropped before the TUI boundary.

## Desired State

The gateway and TypeScript protocol should treat lifecycle diagnostic fields as
stable contract fields, matching `.trellis/spec/backend/runtime-tui-gateway-contract.md`.

This slice should not change tool execution behavior; it should lock the
existing runtime behavior across the gateway and Node client boundary.

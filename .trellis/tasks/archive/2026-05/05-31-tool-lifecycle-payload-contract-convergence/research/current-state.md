# Tool Lifecycle Payload Contract Current State

## Current Behavior

- Runtime tool execution emits `RuntimeStreamEvent` values with kinds
  `tool_start`, `tool_progress`, `tool_complete`, and `tool_failed`.
- `NodeTuiGateway._forward_stream_event()` maps those to `tool.start`,
  `tool.progress`, `tool.complete`, and `tool.failed`.
- The gateway injects `client_turn_id` into every forwarded tool lifecycle
  payload before adding the stream-event metadata.
- Node reducer uses tool lifecycle payloads to update a compact tool timeline
  and deduplicates rows by `tool_id` / `call_id`.
- Python and TypeScript manifest parity already covers required fields and
  property names.

## Gap

The manifest and TypeScript payload contract list `client_turn_id` as a known
property, but not as a required field for `tool.*` events. That under-specifies
the runtime/TUI boundary because tool timeline state needs turn correlation,
and the gateway always emits it.

## Proposed Slice

- Mark `client_turn_id` required for `tool.start`, `tool.progress`,
  `tool.complete`, and `tool.failed` in the Python event schemas.
- Mirror the same required field lists in the TypeScript payload contract map.
- Add Python contract tests locking the required fields for all tool lifecycle
  event schemas.
- Keep runtime behavior unchanged.

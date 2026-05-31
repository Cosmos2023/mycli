# Tool Lifecycle Diagnostic Payload Contract

## Problem

The runtime contract specifies diagnostic completeness fields for
`tool.complete` and `tool.failed`, but the TypeScript protocol types and gateway
smoke fixtures do not currently lock those fields as part of the cross-layer
contract.

This leaves future TUI/extension clients vulnerable to treating bounded summary
and error previews as complete text.

## Scope

In scope:

- Declare `summary_chars` and `summary_truncated` on TypeScript
  `ToolCompletePayload`.
- Declare `summary_chars`, `summary_truncated`, optional `error_chars`, and
  optional `error_truncated` on TypeScript `ToolFailedPayload`.
- Update gateway unit/integration smoke payloads to include diagnostic fields.
- Add or update TypeScript client/reducer tests to narrow and preserve these
  fields.

Out of scope:

- Changing runtime tool execution logic.
- Changing UI rendering beyond preserving existing metadata.
- Productizing MCP, skills, subagent/multi-agent, or ACP.

## Requirements

- Python gateway forwarding tests must prove diagnostic fields survive
  `RuntimeStreamEvent` -> JSON-RPC notification forwarding.
- TypeScript protocol tests must prove typed clients can access diagnostic
  fields without casts.
- Existing transcript reducer tests must continue preserving diagnostic fields.
- No new dependencies.

## Acceptance Criteria

- `uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q` passes.
- `npm --prefix tui/node test -- test/client.test.ts test/reducer.test.ts test/transcript.test.ts` passes.
- `npm --prefix tui/node run typecheck` passes.
- `uv run ruff check tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py` passes.
- Trellis task is archived and committed.

# Tool Lifecycle Long Output Diagnostics Gap

Date: 2026-05-31

Baseline: `feature/mycli-foundation-hardening-audit`

Hermes reference: semantic maturity only. Do not copy Hermes code.

## Current Capabilities

- `ToolExecutionService` emits lifecycle events:
  - `tool_start`
  - `tool_progress`
  - `tool_complete`
  - `tool_failed`
- Node gateway maps these to:
  - `tool.start`
  - `tool.progress`
  - `tool.complete`
  - `tool.failed`
- Tool execution trace rows include:
  - tool name/call id
  - success/status
  - duration
  - effect profile
  - stdout/stderr previews
  - write diagnostic counts/errors
- Node reducer stores lifecycle metadata and updates a single tool row in
  place.

## Gap

Lifecycle summaries and errors are bounded for UI display, but the payload does
not currently say when a summary/error/stdout/stderr preview was truncated or
how large the original value was. This makes long-output diagnostics ambiguous:
the TUI and trace consumers can show a short string, but cannot distinguish
"that was the whole result" from "there is more diagnostic output elsewhere."

Hermes-like tool foundations should make truncation explicit and machine
readable.

## This Slice

Add explicit long-output diagnostics for tool lifecycle and trace payloads:

- `tool.complete` / `tool.failed` metadata should include summary/error
  character counts and truncation flags.
- `tool_execution` trace payload should include stdout/stderr character counts
  and truncation flags alongside previews.
- Existing previews remain bounded and do not include full long output.
- Node reducer should preserve these metadata fields.

## Non-goals

- No external artifact store.
- No log/raw payload deep-link UI.
- No tool cancellation state machine in this slice.
- No MCP/skills/subagent/ACP productization.
- No main merge.

## Verification

- `uv run pytest tests/unit/application/test_tool_execution_service.py -q`
- `npm --prefix tui/node test`
- `npm --prefix tui/node run typecheck`
- `uv run ruff check src/mycli/application/runtime/tools/tool_execution_service.py tests/unit/application/test_tool_execution_service.py`

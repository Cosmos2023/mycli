# Tool Trace Argument Summary Current State

## Current Behavior

- Tool execution trace rows include `arguments` in the `tool_execution` payload.
- `TraceService` recursively redacts secret-like keys and text before writing
  trace JSONL rows.
- `mycli doctor` intentionally does not print raw tool arguments, stdout,
  stderr, summaries, paths, or write diagnostics details.
- Doctor summarizes tool execution diagnostics with counts for failures,
  interruptions, hook denials, truncated output, write diagnostic errors, and
  allowlisted `error_kind` counts.

## Gap

Tool traces are diagnosable only by inspecting raw argument values, which is
not appropriate for doctor output. There is no safe argument-shape summary for
machine or human diagnostics to tell whether traces captured enough call
context without exposing values.

## Proposed Slice

- Add `argument_count` and sorted `argument_keys` to `tool_execution` trace
  payloads.
- Keep existing sanitized `arguments` payload for compatibility.
- Update doctor summary with an `argument_summaries` count showing how many
  tool trace rows carry the safe argument-shape summary.
- Do not print argument key names in doctor output.
- Add tests for trace payload and doctor summary output.

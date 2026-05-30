# Node Gateway Trace Export RPC Notes

## Existing State

- `TraceService.export_jsonl(session_id, tail=50)` returns sanitized JSONL rows.
- `TurnService.export_trace_jsonl(tail=50)` wraps that for the active session.
- `/trace-jsonl` exposes the same rows through the slash command layer with
  `[trace-jsonl]` prefixes.
- `NodeTuiGateway.handle_request()` already routes read-only calls such as
  `status.inspect`, `session.list`, and `transcript.load`.

## Design

Add `trace.export` as a normal JSON-RPC request:

```json
{
  "session_id": "demo",
  "format": "jsonl",
  "rows": ["{\"kind\":\"tool_execution\",...}"]
}
```

Use the gateway's existing `_positive_int(..., default=50)` helper for `tail`
so bounds behavior stays consistent with transcript/session list handling:
invalid values fall back to the default rather than returning a JSON-RPC error.

## Why This Slice

Hermes-like maturity needs clean channels for external clients. A direct RPC is
the smallest step from local diagnostics toward extension/ACP consumers without
committing to a long-running subscription server.

## Risks

- This is still pull-based, not event subscription.
- JSON rows are strings rather than decoded objects by design, preserving the
  JSONL export contract exactly.

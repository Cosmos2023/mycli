# Trace JSONL Export Notes

## Existing Behavior

- `TraceService.append()` writes sanitized runtime trace rows to
  `.mycli/traces/{session_id}-trace.jsonl`.
- `TraceService.load()` reads current trace files and falls back to legacy
  `.mycli/sessions/{session_id}-trace.jsonl`.
- `TurnService.inspect_trace()` renders a human-readable recent summary for
  `/trace`.
- `build_command_handler()` maps slash commands to service methods.

## Design

Use the existing trace persistence as the source of truth and add a read-only
export method. This avoids a second event store and keeps the command useful as
an extension/ACP bootstrap without committing to a long-lived server protocol.

The export should be:

- JSONL, not a JSON array, so future consumers can tail/stream the same shape.
- Bounded by default to avoid dumping large traces accidentally.
- Sanitized by construction using the already-sanitized loaded
  `RuntimeTraceEvent` objects.

## Command Shape

`/trace-jsonl` exports recent JSONL rows with a `[trace-jsonl] ` prefix per row.
The prefix is consistent with current command routing (`[trace]`, `[log]`,
`[session]`) while still leaving valid JSON after the first space for consumers
that strip the prefix.

## Risks

- `/trace-jsonl` is still command output, not a protocol. External integrations
  should treat it as a bootstrap/debug surface until a real subscription server
  exists.
- Large traces can be noisy; default to a recent tail window and keep the
  service API bounded.

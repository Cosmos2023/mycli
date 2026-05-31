# Current State

## Existing Behavior

- `ModelTurnRequester` owns model-adapter streaming normalization.
- It consumes `stream_turn(...)` events and forwards normalized
  `RuntimeStreamEvent` values to a UI/runtime sink.
- Runtime trace already records model retry/fallback events elsewhere, but the
  per-stream success path does not expose TTFB, event counts, text bytes, or
  failure summaries as one structured diagnostic.
- Hermes-agent has stream diagnostics for practical operations: first-token
  timing, chunk counts, byte counts, and retry/failure context.

## Gap

When a stream is slow, sparse, disconnected, or malformed, mycli can surface
some errors, but there is no narrow diagnostics hook at the model stream
normalization boundary. That makes later trace/log integration harder and keeps
stream observability behind Hermes-like maturity.

## Chosen Slice

Add an optional diagnostics sink to `ModelTurnRequester`:

- Records one `ModelStreamDiagnostics` object per streaming request.
- Captures elapsed time, TTFB, total provider event count, text event count,
  tool call event count, completed event count, text byte count, success flag,
  and failure kind/message.
- Emits diagnostics on success and failure.
- Does not change provider transcript construction or UI stream events.
- Does not write logs directly; runtime integration can route this sink into
  trace/log in a follow-up slice.

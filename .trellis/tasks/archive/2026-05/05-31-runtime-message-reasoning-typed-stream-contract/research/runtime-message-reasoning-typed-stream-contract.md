# Runtime Message Reasoning Typed Stream Contract Research

## Existing mycli Findings

- `ModelTurnRequester._request_streaming_turn()` converts adapter stream dicts to
  `RuntimeStreamEvent` for the optional `stream_sink`.
- Current event kinds:
  - `reasoning` with `text`
  - `text_delta` with `text`
  - `tool_call` with `tool_name` and metadata
  - `completed` with metadata
- `NodeTuiGateway._forward_stream_event()` currently sends every non-tool
  lifecycle stream event as `turn.event` with a phase derived by
  `_phase_for_stream_event()`.
- Existing Node TUI depends on `turn.event` for text streaming, so compatibility
  must be preserved until a TUI worktree consumes typed events.

## Hermes Reference Findings

- Hermes emits separate channels:
  - `message.delta`
  - `message.complete`
  - `thinking.delta`
  - `reasoning.delta`
- Hermes has both thinking and reasoning events. For mycli's current single
  reasoning stream, emitting `reasoning.delta` plus `thinking.delta` alias gives
  the TUI a clear migration path without inventing new model semantics.
- Hermes' `message.complete` can carry final assistant text. mycli does not yet
  have final text at the model stream completion event; `turn.completed` remains
  authoritative for final text in this slice.

## Recommended Shape

- Implement typed notification translation in `NodeTuiGateway._forward_stream_event()`.
- Keep `turn.event` emission after typed emissions for all existing events.
- Payloads:
  - `message.delta`: `{client_turn_id, text}`
  - `reasoning.delta`: `{client_turn_id, text}`
  - `thinking.delta`: `{client_turn_id, text}`
  - `message.complete`: `{client_turn_id, ...event.metadata}`
- Do not modify `ModelTurnRequester` unless tests reveal ordering or metadata
  gaps; it already provides the right local event kinds.

## Risks

- Double delivery is intentional for compatibility. Future TUI consumption must
  avoid rendering both typed events and `turn.event` at the same time.
- `message.complete` before `turn.completed` may not include final text. This
  must be documented to avoid treating it as authoritative assistant content.
- Typed event payloads should stay bounded; current stream text is already
  chunk-level, but gateway should not add large derived payloads.

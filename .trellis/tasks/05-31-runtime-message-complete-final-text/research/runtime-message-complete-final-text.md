# Runtime Message Complete Final Text Research

## Current State

- `NodeTuiGateway._forward_stream_event()` emits `message.complete` for `RuntimeStreamEvent(kind="completed")` with `client_turn_id` and stream metadata.
- `NodeTuiGateway._turn_completed_payload()` includes `assistant_message`, `pending_decision`, and `turn_state` in the terminal `turn.completed` notification.
- The Node reducer currently ignores `message.complete`; it finalizes the assistant transcript from `turn.completed.assistant_message`.
- The previous typed stream task explicitly documented that `message.complete` was not authoritative final assistant text yet.

## Gap

Hermes-like clients benefit when `message.complete` can mean a completed assistant message, not only model stream metadata. mycli can add that signal without breaking current clients by sending a second `message.complete` after `turn.completed`, marked with `final: true` and `source: "turn_response"`.

## Design

- Preserve stream-time `message.complete` as-is for compatibility with existing tests and future metadata consumers.
- Add a turn-response final completion event after terminal `turn.completed` only when `_turn_state_for_response(response) == "completed"`.
- Include bounded text. A local constant in the gateway keeps event payloads finite.
- Keep Node TUI consumption out of this slice to avoid duplicate rendering; a future TUI task can switch finalization from `turn.completed` to final `message.complete`.

## Risks

- Emitting two `message.complete` events in a normal turn can confuse clients that assumed uniqueness. The `final` and `source` fields distinguish the terminal final-text event from stream metadata.
- Truncating text means `message.complete.text` is a display/event payload, not a lossless transcript source. `turn.completed.assistant_message` remains the authoritative compatibility source for now.

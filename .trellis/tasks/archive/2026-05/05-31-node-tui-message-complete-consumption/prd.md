# Node TUI Message Complete Consumption

## Background

The runtime/gateway contract now emits typed `message.delta`,
`reasoning.delta`, `thinking.delta`, and `message.complete` notifications. The
Node TUI reducer consumes the delta channels, but `message.complete` currently
has no reducer behavior. That leaves stream-completion metadata as a typed
event that exists in protocol definitions and gateway tests but is invisible to
TUI state.

Hermes-like parity means the TUI should understand completion metadata without
treating it as the final assistant answer. Final assistant text remains owned by
`turn.completed.assistant_message`.

## Goals

- Teach the Node TUI reducer to consume direct `message.complete` events.
- Preserve `runtime.event` envelope unwrapping for `message.complete`.
- Record bounded completion metadata on the active streamed assistant item when
  one exists.
- Clear live reasoning for the matching turn because the model stream is done.
- Preserve authoritative final-answer reconciliation from `turn.completed`.

## Non-Goals

- Do not render a new visible transcript row for `message.complete`.
- Do not mark the turn completed from `message.complete`; terminal state still
  comes from `turn.completed`, `turn.failed`, `turn.status`, and
  `status.update`.
- Do not change Python gateway semantics or JSON-RPC payload shape.
- Do not copy Hermes code.

## Acceptance Criteria

- A direct `message.complete` event for the current streamed assistant item
  annotates that item with bounded `message_complete` metadata.
- A `runtime.event(type="message.complete")` envelope reaches the same reducer
  path.
- `message.complete` clears `liveReasoning` only when the completion belongs to
  the active turn, and leaves `turnRunning` unchanged.
- `turn.completed` still replaces streamed content with
  `assistant_message` authoritatively after `message.complete`.
- Node typecheck and tests pass.

## Verification

- `npm --prefix tui/node run typecheck`
- `npm --prefix tui/node test`
- `git diff --check`

# Node TUI Typed Message Reasoning Stream Consumption

## Goal

Make the Node TUI consume the Hermes-like typed runtime stream channels added
by the runtime branch:

- `message.delta`
- `message.complete`
- `reasoning.delta`
- `thinking.delta`

The TUI should prefer typed message channels for assistant text while keeping
compatibility with older runtimes that only emit `turn.event`.

## Context

- Runtime now emits typed message/reasoning notifications alongside existing
  compatibility `turn.event` notifications.
- The current Node TUI reducer appends assistant text only from
  `turn.event` with `phase: "assistant_delta"`.
- If the TUI consumes both `message.delta` and `turn.event` assistant deltas
  for the same turn, visible assistant text will be duplicated.
- Hermes separates answer text from reasoning/thinking streams. mycli should
  move in that direction without copying Hermes code or changing the Python
  runtime contract again in this slice.

## Requirements

- Consume `message.delta` into the current assistant stream transcript item.
- Prefer typed `message.delta` over compatibility `turn.event` assistant deltas
  for the same active `client_turn_id`.
- Preserve fallback behavior for older runtimes:
  - if no typed message delta has been seen for the turn, existing
    `turn.event phase=assistant_delta` still streams assistant text.
- Consume `reasoning.delta` and `thinking.delta` as a non-answer live reasoning
  signal.
- Reasoning/thinking text must not be appended to the assistant answer body.
- Keep `message.complete` non-authoritative for final assistant text. Final
  content still comes from `turn.completed.assistant_message`.
- Do not change Python gateway behavior in this task unless a TUI test exposes
  a hard contract issue.
- Keep rendering compact and terminal-friendly.

## Non-Goals

- Do not remove `turn.event` compatibility.
- Do not introduce a new versioned event envelope.
- Do not build a full reasoning pane or persistence model.
- Do not change session storage, provider request shape, or runtime transcript
  construction.
- Do not merge into `main`.

## Acceptance Criteria

- Reducer test proves `message.delta` streams assistant text.
- Reducer test proves a following compatibility `turn.event assistant_delta`
  for the same turn is ignored after typed message streaming begins.
- Reducer test proves legacy `turn.event assistant_delta` still works when no
  typed message event is present.
- Reducer test proves `reasoning.delta` / `thinking.delta` do not mutate the
  assistant answer text and update a live reasoning signal instead.
- Rendering test proves live reasoning can be displayed compactly during a
  running turn.
- Node typecheck and relevant Node tests pass.
- Work is committed and archived on `feature/mycli-tui-typed-stream` only.

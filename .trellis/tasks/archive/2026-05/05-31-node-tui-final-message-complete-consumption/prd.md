# Node TUI Final Message Complete Consumption

## Problem

The Python gateway now emits two `message.complete` shapes:

- stream metadata from `RuntimeStreamEvent(kind="completed")`, without `final: true`
- final assistant message text from the terminal turn response, with `final: true` and `source: "turn_response"`

The Node TUI still finalizes assistant output from `turn.completed.assistant_message`. That keeps the UI coupled to terminal turn payloads instead of the Hermes-like message channel.

## Goal

Move Node TUI assistant finalization to the final `message.complete` event while keeping terminal status handling on `turn.completed`.

## Requirements

- Reducer must ignore stream-metadata `message.complete` events that do not have `final: true`.
- Reducer must reconcile assistant transcript text from final `message.complete.text` when `final === true`.
- `turn.completed` should keep updating turn status, pending approval, and live status, but should no longer append or overwrite assistant transcript text.
- Waiting-approval turns must not create blank assistant final rows when they only emit `turn.completed`.
- Existing compatibility `turn.event` assistant deltas must still stream into one assistant item.
- Keep rendering unchanged; this is a reducer/protocol-consumption slice.
- Do not change Python gateway behavior in this slice.
- Do not merge into `main`.

## Acceptance

- Node reducer tests prove streamed deltas finalize from final `message.complete`.
- Node reducer tests prove stream-metadata `message.complete` is ignored.
- Node reducer tests prove `turn.completed` alone does not append a blank final assistant row.
- Node typecheck and Node tests pass.
- Relevant Python gateway tests still pass because this branch includes the runtime contract base.
- Trellis task is archived and commits remain on the feature branch only.

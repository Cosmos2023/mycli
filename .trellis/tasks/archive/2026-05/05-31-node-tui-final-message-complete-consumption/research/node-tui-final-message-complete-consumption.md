# Node TUI Final Message Complete Consumption Research

## Current State

- `tui/node/src/state/reducer.ts` handles `turn.event` with `phase="assistant_delta"` by appending to an `assistant_stream` item.
- The same reducer currently handles `turn.completed` by calling `reconcileFinalAnswer(...assistant_message)`.
- `message.complete` is currently ignored by the reducer.
- `reconcileFinalAnswer()` already provides the right behavior for replacing a trailing `assistant_stream` item with `assistant_final`, or appending a final item if no stream exists.

## Runtime Contract Base

- The current branch is based on `feature/mycli-runtime-message-complete-final`, where Python emits a final `message.complete` after `turn.completed` for completed turns.
- Stream metadata `message.complete` events do not include `final: true`.
- Final message completion events include:
  - `client_turn_id`
  - bounded `text`
  - `final: true`
  - `source: "turn_response"`

## Design

- Add a reducer branch for `gateway.event` `message.complete`.
- If `params.final !== true`, ignore it.
- If `params.final === true`, call `reconcileFinalAnswer(state.transcript, String(params.text ?? ""))`.
- Remove transcript reconciliation from `turn.completed` so waiting-approval terminal events do not produce blank final assistant rows and normal completed turns finalize through the typed message channel.

## Risks

- Older Python runtimes that do not emit final `message.complete` would no longer finalize from `turn.completed`. This branch is intentionally based on the runtime final-message contract and should be integrated with that runtime branch, not independently.
- `message.complete.text` is bounded for UI/event safety. It is suitable for display; persisted session history remains the durable transcript source.

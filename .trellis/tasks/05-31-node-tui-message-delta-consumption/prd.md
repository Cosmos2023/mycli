# Node TUI Message Delta Consumption

## Problem

The Python gateway emits typed `message.delta` notifications for assistant text, but the Node TUI still builds assistant stream rows from compatibility `turn.event` notifications with `phase="assistant_delta"`. That leaves the TUI only partially migrated to the Hermes-like message channel and keeps duplicate-rendering risk alive while both event families exist.

## Goal

Move Node TUI assistant streaming to typed `message.delta` while preserving non-message compatibility paths.

## Requirements

- Reducer must append assistant stream text from `gateway.event` `message.delta`.
- Reducer must no longer append assistant text from compatibility `turn.event` with `phase="assistant_delta"`.
- Reducer must keep handling compatibility `turn.event` tool-call rows for now.
- Finalization must continue to use final `message.complete` with `final === true`.
- Stream metadata `message.complete` must remain ignored.
- Do not change Python gateway behavior in this slice.
- Do not merge into `main`.

## Acceptance

- Node reducer tests prove `message.delta` builds one assistant stream row and final `message.complete` reconciles it.
- Node reducer tests prove compatibility `turn.event assistant_delta` no longer appends assistant text.
- Existing transcript helper tests continue to pass.
- Node tests and typecheck pass.
- Python gateway tests continue to pass.
- Trellis task is archived and commits remain on the feature branch only.

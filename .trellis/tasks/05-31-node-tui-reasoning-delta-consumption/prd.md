# Node TUI Reasoning Delta Consumption

## Problem

The Python gateway already emits typed `reasoning.delta` and `thinking.delta`
notifications as part of the Hermes-like runtime/TUI channel split. The Node TUI
currently consumes typed assistant text via `message.delta`, but reasoning
chunks are still not represented in reducer state.

This leaves the TUI with a generic running label during model reasoning, and it
keeps the typed contract only partially consumed.

## Goal

Consume typed `reasoning.delta` and `thinking.delta` in the Node reducer as
live running status signals.

## Scope

- Update `tui/node/src/state/reducer.ts`.
- Add reducer tests in `tui/node/test/reducer.test.ts`.
- Update `.trellis/spec/backend/runtime-tui-gateway-contract.md`.

## Requirements

- `reasoning.delta` updates `liveStatus` while the turn is running.
- `thinking.delta` is accepted as the compatibility alias and behaves the same
  way.
- Reasoning/thinking deltas do not append transcript rows.
- Compatibility `turn.event` reasoning messages do not drive transcript text.
- The status text is bounded for display and falls back to `Thinking` for empty
  text.
- Existing message stream/finalization behavior remains unchanged.

## Non-Goals

- No new visual component in this slice.
- No Python gateway changes.
- No Hermes code copying.
- No merge to `main`.

## Acceptance

- Reducer unit tests cover typed reasoning/thinking consumption and transcript
  isolation.
- Node typecheck passes.
- Relevant Python gateway tests remain green.

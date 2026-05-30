# Node TUI Typed Message Reasoning Stream Consumption Research

## Existing Node TUI Findings

- `tui/node/src/state/reducer.ts` handles gateway notifications through the
  `gateway.event` action.
- Assistant streaming currently depends on:
  - `method === "turn.event"`
  - `params.phase === "assistant_delta"`
  - `applyTextDelta(state.transcript, text)`
- `turn.completed` remains the authoritative final answer and calls
  `reconcileFinalAnswer(...)`.
- Tool lifecycle channels already use typed methods directly:
  - `tool.start`
  - `tool.complete`
  - `tool.failed`
- Transcript rendering chooses `assistantFinal ?? assistantStream`, so adding
  typed message deltas can reuse the existing `assistant_stream` item.
- There is currently no reducer state for reasoning/thinking chunks.

## Runtime Contract Findings

- Runtime emits typed message/reasoning notifications before the compatibility
  `turn.event` notification for the same stream event.
- Current typed payloads:
  - `message.delta`: `{client_turn_id, text}`
  - `reasoning.delta`: `{client_turn_id, text}`
  - `thinking.delta`: `{client_turn_id, text}`
  - `message.complete`: `{client_turn_id, ...metadata}`
- `message.complete` is stream completion metadata only in this slice. Final
  assistant text remains in `turn.completed.assistant_message`.

## Recommended Design

- Add small live stream bookkeeping to `ShellState`, not a separate transcript
  item model:
  - track the active turn id that has received typed message deltas
  - track the latest reasoning/thinking preview for compact live display
- On `message.delta`:
  - append text to the existing assistant stream item
  - remember that this `client_turn_id` now uses typed message streaming
- On legacy `turn.event phase=assistant_delta`:
  - if that same `client_turn_id` has already received typed message deltas,
    ignore it to avoid duplicate answer text
  - otherwise preserve old fallback behavior
- On `reasoning.delta` / `thinking.delta`:
  - update live reasoning preview
  - do not append to assistant stream
- On terminal events:
  - clear typed stream bookkeeping for the completed/failed/interrupted turn
  - keep final assistant reconciliation unchanged

## Rendering Notes

- The least invasive UI is to extend `RunningActivity` with a short reasoning
  suffix when a turn is running.
- Do not add a large reasoning transcript block in this slice; it would need
  folding, persistence, and view-mode decisions.
- Keep reasoning preview bounded to avoid noisy status lines.

## Risks

- If typed and compatibility events arrive out of order, duplicate avoidance
  depends on `client_turn_id`. Legacy events without a matching id should still
  fall back to existing behavior.
- Rendering both typed text and compatibility deltas is the main regression to
  prevent.
- Reasoning labels should remain generic. mycli currently has one reasoning
  stream; `thinking.delta` is an alias, not separate semantics.

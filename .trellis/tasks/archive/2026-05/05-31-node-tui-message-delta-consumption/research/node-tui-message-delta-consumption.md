# Node TUI Message Delta Consumption Research

## Current State

- `NodeTuiGateway` emits both typed `message.delta` and compatibility `turn.event` with `phase="assistant_delta"` for text deltas.
- `tui/node/src/state/reducer.ts` currently appends assistant stream text from `turn.event` `assistant_delta`.
- The previous TUI slice moved final answer reconciliation to final `message.complete`.
- `applyTextDelta()` already contains the required stream-row append/coalesce behavior.

## Design

- Add a reducer branch for `action.method === "message.delta"` that calls `applyTextDelta()`.
- Remove the assistant-delta branch for `turn.event`.
- Keep `turn.event` tool-call handling unchanged because tool-call compatibility has a separate rendering path and typed tool lifecycle rendering is already covered by previous slices.

## Risks

- This branch assumes a runtime that emits typed `message.delta`. It is based on the runtime/TUI final-message branch and should be integrated with the typed-message runtime lineage, not independently paired with older runtime gateways.
- If both `message.delta` and `turn.event assistant_delta` were consumed, assistant text would duplicate. Removing the compatibility rendering path avoids that.

# Node TUI Reasoning Delta Notes

## Existing State

- `message.delta` is already consumed by `reduceShellState` and appended to the
  assistant stream transcript.
- Final `message.complete` with `final: true` reconciles the final assistant
  transcript.
- Compatibility `turn.event phase=assistant_delta` is ignored by the reducer to
  avoid duplicate stream text during the migration period.
- `RunningActivity` renders `state.liveStatus?.text || "Thinking"`, so the
  reducer can improve reasoning visibility without a new component.

## Contract Direction

Hermes-like parity means separate channels for assistant text, reasoning,
status, tool lifecycle, and approvals. Reasoning/thinking is not assistant
answer content and should not become transcript text.

## Implementation Choice

Treat `reasoning.delta` and `thinking.delta` as status updates:

- `state: "running"`
- `kind: "reasoning"` or `"thinking"`
- `text: "Thinking: <bounded preview>"` when text is present
- `text: "Thinking"` when text is empty
- `client_turn_id` preserved when present
- `turnRunning: true`
- `currentTurnId` updated from payload when present

The preview should be local and simple. This keeps the slice reversible and
avoids introducing a broader rendering model before the TUI has a richer
reasoning panel.

## Risks

- Very long reasoning deltas can make the status line noisy. Bound the preview.
- Rendering reasoning as transcript content would blur the answer/reasoning
  channel boundary and diverge from the runtime contract.

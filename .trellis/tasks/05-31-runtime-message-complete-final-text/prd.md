# Runtime Message Complete Final Text Contract

## Problem

The runtime gateway already emits Hermes-like `message.delta`, `reasoning.delta`, `thinking.delta`, and `message.complete` notifications. The current `message.complete` notification only mirrors model stream completion metadata. The final assistant text is still available only on `turn.completed.assistant_message`.

That kept the previous typed-stream slice small, but it leaves `message.complete` short of the Hermes-like meaning of "the assistant message is complete" and forces future TUI or extension clients to keep treating terminal turn events as the only final-message source.

## Goal

Emit a bounded final-message completion notification after the turn response is known, while preserving current `turn.completed` compatibility.

## Requirements

- Keep existing stream-time `message.complete` emitted from `RuntimeStreamEvent(kind="completed")` for model completion metadata compatibility.
- When a turn finishes without a pending decision, emit a second `message.complete` after `turn.completed` with:
  - `client_turn_id`
  - `text`: final `TurnResponse.assistant_message`
  - `final: true`
  - `source: "turn_response"`
- If the response is waiting for approval, do not emit the final-text `message.complete`, because there is no final assistant answer yet.
- Apply the same behavior to approval-resolution turns when they finish with a real assistant message.
- Do not remove or alter `turn.completed.assistant_message`.
- Do not change provider transcript construction, session persistence, request-shape/cache inputs, or Node TUI rendering in this slice.
- Keep payload bounded so a very large final assistant message is not sent unbounded through the gateway event channel.

## Non-Goals

- Do not make the Node TUI consume final-text `message.complete` yet.
- Do not remove the compatibility stream `turn.event` or terminal `turn.completed` payload.
- Do not merge into `main`.

## Acceptance

- Gateway tests prove ordinary completed turns emit both the model metadata `message.complete` and final-text `message.complete`.
- Gateway tests prove waiting-approval turns do not emit final-text `message.complete`.
- Gateway tests prove approval-response turns emit final-text `message.complete` when completed.
- Runtime TUI gateway contract spec documents the two `message.complete` sources and bounded final text.
- Relevant Python tests, ruff, mypy, and `git diff --check` pass.

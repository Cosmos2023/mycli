# Pending Clarification Recovery Doctor Check Research

## Current State

- Clarification waits are persisted as `suspended_turn` rows with a nested
  `pending_clarification` payload.
- `TurnExecutor.resolve_pending_clarification()` resumes from that suspended
  turn and needs the original `user_message` plus the pending clarification
  request id.
- `DoctorService` currently validates only broad recovery state shape for
  `suspended_turn`: the row must be an object, `user_message` must be a string,
  `conversation` must be a list when present, and nested clarification payloads
  must contain a `tool_call` object.
- A `suspended_turn` with `pending_clarification` and a blank `user_message`
  can pass doctor shape checks even though it is not useful resume evidence for
  the waiting user turn.

## Gap

A partial or corrupted sessions DB can retain `pending_clarification` state
without enough evidence to resume the correct waiting turn. Hermes-like local
agent foundations should make this diagnosable instead of letting resume fail
later with weak context.

## Direction

Extend the read-only session DB integrity checks:

- Inspect `suspended_turn` rows containing `pending_clarification`.
- Require a non-blank `user_message` on the explicit suspended state, or a
  waiting-clarification `turn_record` with a non-blank `user_message`, or a
  waiting-clarification rollout plus matching user history item.
- Report bounded session ids without printing raw `payload_json`.
- Do not repair, clear, or rewrite pending clarification state.

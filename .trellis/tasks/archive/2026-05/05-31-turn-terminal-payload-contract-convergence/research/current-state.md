# Turn Terminal Payload Contract Current State

## Current Behavior

- `NodeTuiGateway._turn_completed_payload()` emits `turn.completed` with a
  stable payload shape:
  - `client_turn_id`
  - `assistant_message`
  - `activity_events`
  - `progress_updates`
  - `plan_steps`
  - `pending_decision`
  - `turn_state`
  - `usage`
- `turn.status` already has required fields in both Python and TypeScript:
  `state`, `kind`, `text`, and `terminal`.
- Node reducer uses `turn.completed.assistant_message` as compatibility final
  text and uses `turn.status` for normalized terminal/waiting outcome routing.
- Node manifest parity tests compare the TypeScript payload contract map
  against the live Python manifest.

## Gap

`turn.completed` is advertised in the manifest with no required fields even
though the gateway always emits a full compatibility payload. External runtime
clients cannot discover the minimum stable event shape from the manifest and
must infer it from implementation details.

## Proposed Slice

- Mark the real `turn.completed` payload fields as required in the Python
  gateway event schema.
- Mirror the same required fields in the TypeScript payload contract map.
- Add Python contract tests for `turn.completed` and `turn.status` schemas.
- Keep runtime behavior unchanged.

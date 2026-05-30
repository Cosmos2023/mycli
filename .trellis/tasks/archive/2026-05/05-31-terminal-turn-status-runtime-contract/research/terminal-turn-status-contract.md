# Terminal Turn Status Contract Research

## Existing Event Split

- `turn.completed` is emitted for successful runtime turns and includes
  `turn_state`.
- A completed turn with a pending decision uses `turn_state=waiting_approval`.
- `turn.failed` is emitted with `client_turn_id` and a human-readable failure
  message.
- `turn.interrupted` is emitted from the interrupt request path with only
  `requested: true`.
- `status.update` tracks live UI status for running, waiting approval,
  completed, failed, and interrupted states.
- `runtime.event` mirrors method-name events, but clients still need to know
  which method names imply a turn outcome.

## Recommended Shape

- Add a mirrored `turn.status` event rather than changing existing terminal
  events.
- Keep the payload close to `status.update`, with one additional `terminal`
  boolean so external clients can decide whether a turn is finished or waiting
  for user input.
- Emit the existing event first, then `turn.status`, then `status.update` where
  relevant. This preserves the current TUI compatibility path while giving
  future clients the normalized event.

## Proposed Payload

```json
{
  "client_turn_id": "client_1",
  "state": "completed",
  "kind": "completed",
  "text": "Completed",
  "terminal": true
}
```

For failures:

```json
{
  "client_turn_id": "client_1",
  "state": "failed",
  "kind": "failed",
  "text": "Failed",
  "terminal": true,
  "message": "Model turn failed"
}
```

For waiting approval:

```json
{
  "client_turn_id": "client_1",
  "state": "waiting_approval",
  "kind": "waiting_approval",
  "text": "Waiting approval",
  "terminal": false
}
```

## Risks

- A new event changes exact event-order assertions.
  - Mitigation: update tests to assert the compatible relative order and the
    new event explicitly.
- The existing interrupt path does not stop the worker thread.
  - Mitigation: document that `turn.status(state=interrupted)` reflects the
    request status, not guaranteed worker cancellation.
- Node TUI could double-handle status if changed to consume both `turn.status`
  and `status.update` immediately.
  - Mitigation: leave Node reducer behavior unchanged in this slice.

## Out Of Scope

- No TypeScript rendering changes.
- No reducer migration to consume `turn.status`.
- No cooperative cancellation.
- No runtime ledger or session schema changes.

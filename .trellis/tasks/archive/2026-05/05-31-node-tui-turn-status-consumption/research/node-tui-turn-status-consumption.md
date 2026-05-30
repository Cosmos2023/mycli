# Node TUI Turn Status Consumption Research

## Existing Reducer Behavior

- `status.update` updates `liveStatus`, `turnRunning`, `currentTurnId`, and
  clears live reasoning/typed-message bookkeeping when the state is terminal.
- `turn.completed` finalizes the assistant answer and sets a live status from
  the completed payload.
- `turn.failed` appends an error transcript item and sets failed live status.
- `approval.request` creates the pending approval state and transcript row.
- `runtime.event` unwraps into the same reducer path as direct method-name
  notifications.

## Recommended Approach

- Treat `turn.status` as a status-only event. It should update live state but
  should not create transcript items.
- Reuse the existing `liveStatusFromParams(...)` parsing path because
  `turn.status` is intentionally close to `status.update`.
- Add one helper for status application so `status.update` and `turn.status`
  cannot drift.
- Keep `turn.completed` and `turn.failed` behavior unchanged; if both direct
  terminal event and `turn.status` arrive, transcript writes still happen only
  on the original terminal event.
- Add focused reducer tests rather than rendering tests because this slice does
  not change visible UI components.

## Risks

- Double-rendering final answer or error if `turn.status` appends transcript
  rows.
  - Mitigation: reducer tests assert transcript length remains unchanged for
    `turn.status`.
- Prematurely clearing approvals on `waiting_approval`.
  - Mitigation: waiting-approval test asserts pending approval is preserved.
- Invalid payloads changing UI state.
  - Mitigation: parser should return null and reducer should return the
    original state.

## Out Of Scope

- No Python gateway changes.
- No Ink component rendering changes.
- No transport dedup strategy for direct events versus `runtime.event` mirrors.
- No terminal cancellation behavior changes.

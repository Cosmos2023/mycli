# Pending Approval Recovery Doctor Check Research

## Current State

- `SessionService.reconstruct_suspended_turn()` can recover an approval turn
  from persisted runtime state when explicit `suspended_turn` state is missing.
- Reconstruction requires pending approval plus a `turn_record` or
  `turn_rollout` with `WAITING_APPROVAL` and a recoverable user message.
- `DoctorService` validates recovery state JSON shape for `pending_decision`,
  `suspended_turn`, and `turn_record`.
- Doctor does not currently check whether a persisted `pending_decision` has a
  matching waiting-approval turn evidence path.

## Gap

A corrupt or partial session DB can contain `pending_decision` while lacking any
waiting approval `turn_record`, `turn_rollout`, or user message evidence. The
payload shape is valid, so doctor reports the sessions DB as healthy even though
resume/approval resolution cannot reconstruct the suspended turn.

## Direction

Extend the read-only session DB integrity check to detect pending decisions that
cannot be resumed:

- For each `pending_decision`, require either a valid `suspended_turn` state or
  waiting-approval runtime evidence.
- Runtime evidence may be `turn_record.status=waiting_approval` with
  `user_message`, or a `turn_rollouts.status=waiting_approval` row with a
  matching `history_items` user message.
- Report bounded `session_id` references without printing raw payload JSON.

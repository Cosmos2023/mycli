# Pending Clarification Recovery Doctor Check

## Problem

`mycli doctor` validates the broad JSON shape of `suspended_turn`, but it does
not prove that a pending clarification can resume the correct waiting turn. A
DB can contain `pending_clarification` state with no usable user message or
waiting-clarification evidence and still pass `sessions_db`.

## Goal

Make doctor detect pending clarification state that is not resumable, while
remaining read-only and bounded.

## Scope

- Add a read-only session DB integrity check for `suspended_turn` rows that
  contain `pending_clarification`.
- Treat explicit `suspended_turn.user_message` with non-blank text as
  resumable.
- Treat waiting clarification `turn_record` with non-blank `user_message` as
  resumable.
- Treat waiting clarification `turn_rollout` plus matching user history item as
  resumable.
- Report bounded session ids and do not print raw state payloads.
- Record the new doctor/session DB rule in backend specs.

## Non-Goals

- No automatic repair.
- No schema migration.
- No runtime clarification behavior change.
- No TUI UI changes.
- No merge to `main`.

## Acceptance

- Doctor fails when `suspended_turn.pending_clarification` exists but has no
  explicit user message, no waiting-clarification `turn_record`, and no
  waiting-clarification rollout/history evidence.
- Doctor passes when the pending clarification has a non-blank explicit
  suspended `user_message`.
- Doctor passes when the pending clarification is reconstructable from
  waiting-clarification `turn_record` evidence.
- Doctor passes when the pending clarification is reconstructable from
  waiting-clarification rollout/history evidence.
- Existing doctor/session tests continue passing.

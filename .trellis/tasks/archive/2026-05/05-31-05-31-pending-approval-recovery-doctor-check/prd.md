# Pending Approval Recovery Doctor Check

## Problem

`mycli doctor` validates pending approval payload shape, but not whether the
pending approval can actually be resumed. A DB can pass doctor with a
`pending_decision` row and no waiting approval turn evidence.

## Goal

Make doctor detect pending approval state that cannot be resumed to the correct
waiting turn.

## Scope

- Add a read-only session DB integrity check for `pending_decision` recovery
  evidence.
- Treat explicit valid `suspended_turn` state as resumable.
- Treat waiting approval `turn_record` with a user message as resumable.
- Treat waiting approval `turn_rollout` plus a matching user history item as
  resumable.
- Report bounded session ids; do not print raw state payloads.

## Non-Goals

- No automatic repair.
- No schema migration.
- No approval policy change.
- No merge to `main`.

## Acceptance

- Doctor fails when `pending_decision` exists without `suspended_turn`,
  waiting-approval `turn_record`, or waiting-approval rollout/history evidence.
- Doctor passes when `pending_decision` is paired with valid `suspended_turn`.
- Doctor passes when `pending_decision` is reconstructable from
  waiting-approval `turn_record` or rollout/history evidence.
- Existing doctor/session tests continue passing.

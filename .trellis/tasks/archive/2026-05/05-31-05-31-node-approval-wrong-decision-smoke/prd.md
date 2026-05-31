# Node Approval Wrong Decision Smoke

## Problem

The gateway correctly rejects approval responses with an unknown decision id,
but the real Node scripted path does not yet verify this negative path. A
regression here could clear the wrong approval or hide the error from the user.

## Goal

Prove a wrong `approval.respond.decision_id` produces a visible request error
while preserving the pending approval state.

## Scope

- Add a real Node scripted integration smoke using `approval.respond_raw`.
- Reuse the existing waiting-state fake service.
- Assert the service does not call `resolve_pending_decision`.
- Assert dumped state keeps the original pending approval.
- Assert dumped state includes one request error row for
  `decision_not_pending`.

## Non-Goals

- No approval policy changes.
- No gateway protocol changes.
- No visual redesign.
- No merge to `main`.

## Acceptance

- Integration test fails if wrong decision id clears pending approval.
- Integration test fails if wrong decision id is not visible as a request error.
- Existing Node gateway integration tests pass.
- Relevant lint/test command passes.

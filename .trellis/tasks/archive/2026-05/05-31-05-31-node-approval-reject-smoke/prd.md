# Node Approval Reject Smoke

## Problem

The Node TUI gateway has real scripted smoke coverage for approval approval, but
not for approval rejection. Rejection is a distinct terminal state and must
clear pending approval without producing final assistant text.

## Goal

Verify the real Node scripted client/gateway path handles approval rejection as
a terminal `rejected` turn.

## Scope

- Add a real Node scripted smoke for `approval.respond(choice=reject)`.
- Use the existing fake waiting-state service pattern.
- Assert the service receives mapped runtime choice `"2"`.
- Assert the dumped Node state has `pendingApproval=null`.
- Assert `liveStatus.state === "rejected"` and the rejection message is present.
- Assert no assistant final/stream item is appended for the rejected turn.

## Non-Goals

- No visual redesign.
- No new approval choices.
- No runtime approval policy change unless the smoke exposes an actual defect.
- No merge to `main`.

## Acceptance

- Integration test fails without correct Node/gateway rejected-state behavior.
- Integration test passes through the real Node scripted client process.
- Relevant Node TUI gateway integration test passes.
- If code changes are needed, Python lint/tests for changed files pass.

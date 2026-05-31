# Scripted Approval Request Error Smoke

## Problem

The Node scripted client is used for real gateway smokes, but request failures
currently throw without being reduced into shell state. This means approval
negative paths such as no-pending approval cannot be asserted from the dumped
TUI state, even though the interactive app handles them.

## Goal

Make the scripted client capture JSON-RPC request failures into TUI state and
add a smoke for `approval.respond` when no pending approval exists.

## Scope

- Reuse `GatewayRequestError` in the scripted client.
- Add a scripted action for sending `approval.respond` with an explicit
  `decision_id`, bypassing the pending-approval precondition.
- On request failure, reduce `request.failed` so the dumped state contains the
  same error transcript row as `RuntimeApp`.
- Keep existing normal approval/clarification scripted flows unchanged.

## Non-Goals

- No gateway protocol change.
- No reducer redesign.
- No visual redesign.
- No merge to `main`.

## Acceptance

- A scripted client unit test proves a JSON-RPC error from `approval.respond`
  is reduced into exactly one error transcript row.
- The error row includes method, code, message, and source=`request`.
- The scripted client still shuts down and dumps state after the expected
  request error.
- Existing scripted client tests pass.

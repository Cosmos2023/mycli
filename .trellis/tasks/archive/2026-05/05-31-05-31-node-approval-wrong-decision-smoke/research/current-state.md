# Node Approval Wrong Decision Smoke Research

## Current State

- Gateway rejects `approval.respond` when `decision_id` does not match the
  active pending approval id or the `decision_current` alias.
- Reducer tests prove request failures become visible error rows and do not
  duplicate matching `gateway.error` events.
- Scripted client now supports `approval.respond_raw` and can keep dumped TUI
  state after expected request failures.
- Real Node scripted smoke covers approve-once and reject success paths, but not
  the wrong-decision-id failure while a pending approval remains active.

## Gap

Hermes-like approval safety requires wrong decision responses to fail without
resolving or clearing the pending approval. This has gateway logic but lacks a
real Node/gateway smoke proving the TUI state remains pending and shows the
request error.

## Direction

Add a real Node scripted gateway smoke:

1. Submit a turn that creates a pending approval.
2. Send `approval.respond_raw` with an incorrect `decision_id` and
   `expect_error=true`.
3. Dump state and assert the pending approval remains, one request error is
   visible, and the service never resolves the decision.

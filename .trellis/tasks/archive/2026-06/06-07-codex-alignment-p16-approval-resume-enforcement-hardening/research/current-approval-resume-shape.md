# Current Approval Resume Shape

## Existing Flow

`TurnExecutor.execute_user_turn()` checks runtime state before starting a new
model turn:

1. `SessionService.load_pending_decision(session_id)`
2. `SessionService.load_suspended_turn(session_id)`
3. if suspended turn has `pending_approval`, synthesize a `PendingDecision` for
   display via `RuntimeApprovalDecisions.pending_decision_from_approval(...)`
4. otherwise resume interrupted non-approval suspended turns

`TurnExecutor.resolve_pending_approval(choice)` currently starts from
`load_pending_decision(session_id)`. If that row is missing, it records
`approval_resolution.result=no_pending_decision` and returns without checking
whether a structured suspended turn still contains `pending_approval`.

## Existing Recovery Support

`SessionService.reconstruct_suspended_turn(session_id, decision)` can rebuild a
`SuspendedTurn` from runtime snapshot and waiting-approval turn rollout state.
This covers the case where `pending_decision` survived but `suspended_turn` was
lost.

The inverse case is not covered: if structured `suspended_turn.pending_approval`
survives but `pending_decision` is missing, user-visible state and resolution
state diverge.

## P16 Fit

The minimal hardening path is to centralize pending-approval recovery in
`TurnExecutor`:

- load `pending_decision`;
- load `suspended_turn`;
- if decision is missing but suspended pending approval exists, synthesize and
  persist/use the decision before validating the user's choice;
- if decision exists but suspended turn is missing, use existing
  `reconstruct_suspended_turn(...)`;
- emit bounded local diagnostics for fallback recovery and unrecoverable state.

This keeps runtime enforcement provider-free and avoids changing provider
request shape or compact rehydration.

## Redaction Boundary

Approval resume diagnostics may expose only:

- result/status code;
- tool name;
- call id presence or bounded call id;
- option count;
- command pattern presence;
- state booleans such as `pending_decision`, `suspended_turn`, and
  `pending_approval`.

They must not expose raw tool arguments, raw shell command text, raw user
prompt, raw tool output, provider payload bodies, headers, or secret-like
values.

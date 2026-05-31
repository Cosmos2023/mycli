# Node Approval Reject Smoke Research

## Current State

- Python gateway accepts `approval.respond` and maps `choice=reject` through the
  normal decision resolver.
- Runtime contract specifies rejected approvals as terminal:
  `approval.respond`, `turn.completed(turn_state=rejected)`,
  `turn.status(state=rejected, terminal=true)`, and
  `status.update(state=rejected)`, with no final-text `message.complete`.
- Reducer tests cover terminal rejected status and pending approval cleanup.
- Real Node scripted smoke currently covers approval approve-once and
  clarification response in one route, but not approval rejection through the
  actual Node client/gateway process.

## Gap

The real Node scripted client path can regress approval rejection without the
existing smoke detecting it. A rejected approval is important because it must
clear pending state, terminate the turn as rejected, and avoid final answer
duplication.

## Direction

Add a real Node scripted gateway smoke that sends a pending approval and then
responds with `choice=reject`. The fake service should return a rejected
`TurnResponse` carrying `TurnStatus.REJECTED` and
`StopReason.APPROVAL_REJECTED`, so the dumped Node state proves terminal
`rejected` handling.

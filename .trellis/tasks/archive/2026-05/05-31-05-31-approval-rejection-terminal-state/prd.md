# Approval Rejection Terminal State

## Problem

Rejected approval decisions currently finalize as ordinary assistant
completion. This hides a safety decision behind `completed` semantics and makes
the Node TUI, trace consumers, and future extension clients unable to tell
whether a risky tool was denied or the assistant finished normally.

## Scope

In scope:

- Python runtime stop reason and turn status for rejected approvals.
- Node TUI gateway `turn.status` and `status.update` mapping for rejected
  approval outcomes.
- TypeScript protocol/reducer support for the rejected terminal state.
- Runtime gateway contract documentation and focused tests.

Out of scope:

- MCP, skills, subagent/multi-agent, or ACP productization.
- Redesigning the full approval policy engine.
- Copying Hermes implementation code.

## Requirements

- Rejected approvals must be persisted with explicit machine-readable semantics.
- Gateway notifications must expose rejection as a terminal outcome distinct
  from normal completion.
- Reducer terminal-state handling must clear live turn state and pending
  approval/clarification state for rejected outcomes.
- Compatibility RPC method `decision.resolve` must continue sharing the same
  behavior as `approval.respond`.

## Acceptance Criteria

- Integration test proves rejecting a pending decision clears pending state and
  returns a turn with `status=rejected` and `stop_reason=approval_rejected`.
- Gateway unit test proves `approval.respond(choice=reject)` emits
  `turn.status(state=rejected, terminal=true)` and matching `status.update`.
- Node reducer test proves `turn.status(state=rejected)` is accepted as a
  terminal state and clears pending/live state.
- Runtime contract spec documents `rejected` as a terminal turn state and
  approval rejection stop reason.
- Focused Python and Node tests pass.

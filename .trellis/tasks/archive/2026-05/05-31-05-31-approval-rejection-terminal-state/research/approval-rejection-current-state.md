# Approval Rejection Current State

## Current behavior

- `TurnExecutor.resolve_pending_approval()` maps `DecisionAction.REJECT` to a
  finalized turn with `TurnStatus.COMPLETED` and
  `StopReason.ASSISTANT_COMPLETED`.
- `NodeTuiGateway._run_decision_worker()` derives the terminal UI state from
  the response. Since rejected approvals look like normal completion, the
  gateway emits `turn.status(state=completed)` and
  `status.update(state=completed)`.
- The Node reducer treats `completed`, `failed`, and `interrupted` as terminal
  states. There is no explicit rejected terminal state in the TypeScript
  protocol or reducer.

## Risk

A user rejecting a risky tool is materially different from an assistant
successfully finishing a turn. Treating both as ordinary completion makes
history, trace consumers, TUI status, and future extension clients unable to
distinguish safe user denial from successful execution.

## Target contract

- Runtime persistence should expose approval rejection with a machine-readable
  `StopReason.APPROVAL_REJECTED`.
- Gateway/TUI clients should receive a distinguishable terminal turn state
  rather than inferring rejection from human text.
- The rejected outcome should clear pending approval/clarification state and
  stop live turn bookkeeping without appending duplicate transcript output.
- Existing `approval.respond` / `decision.resolve` request compatibility should
  remain intact.

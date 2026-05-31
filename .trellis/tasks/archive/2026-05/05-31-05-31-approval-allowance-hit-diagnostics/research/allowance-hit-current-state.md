# Approval Allowance Hit Diagnostics

## Current behavior

- `allow_session` grants are now visible through `approval_allowance` trace/log
  diagnostics.
- Later risky shell calls can be auto-approved when
  `ApprovalService._matches_session_allowance()` finds the same command
  pattern.
- That later auto-approval does not currently emit an explicit diagnostic
  event. The only observable result is that the turn continues without a new
  pending approval.

## Gap

When a risky command runs without a prompt, diagnostics need to explain whether
the tool was intrinsically safe or was allowed because of a previous
session-scoped approval.

## Target

- `ApprovalOutcome` should carry whether `auto_approved` came from a session
  allowance hit.
- The runtime should trace and log `approval_auto_allowed` when the session
  allowance path is used.
- The event should include the matched command pattern, tool name, call id,
  decision id, and reason.

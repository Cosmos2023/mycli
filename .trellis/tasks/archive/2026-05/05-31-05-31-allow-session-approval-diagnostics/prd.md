# Allow Session Approval Diagnostics

## Problem

Session-scoped approval grants currently affect future tool execution but are
not directly visible in trace or operational logs. This weakens safety
diagnostics because a later auto-approved risky command cannot be traced back
to the approval decision that granted the allowance without inspecting internal
state.

## Scope

In scope:

- Runtime trace event for accepted `allow_session` decisions.
- Workspace log line for accepted `allow_session` decisions.
- Tests proving the trace/log payload includes bounded, useful fields.

Out of scope:

- Changing the approval policy.
- Productizing MCP, skills, subagents, or ACP.
- Adding an allowlist management UI.

## Requirements

- Accepting `DecisionAction.ALLOW_SESSION` must continue to add the command
  allowance exactly as before.
- The runtime must append a trace event with kind `approval_allowance`.
- The trace payload must include `action`, `tool_name`, `call_id`,
  `command_pattern`, `decision_id`, `new_allowance`, and `reason`.
- The workspace log must record event `approval_allowance` at info level with
  the same core diagnostic fields.
- Duplicate allowance grants should be observable as `new_allowance=false`.

## Acceptance Criteria

- Integration test proves `resolve_pending_decision("3")` writes
  `approval_allowance` trace and log diagnostics.
- Existing allowlist behavior tests still pass.
- Trace/log diagnostics do not include raw secrets beyond existing redaction.
- Focused Python tests and ruff pass.

# Approval Allowance Hit Diagnostics

## Problem

Session-scoped approval grants are now recorded when created, but subsequent
risky tool calls that hit those grants still execute without an explicit
diagnostic event. This leaves a gap in the safety chain: a trace reader can see
that an allowance was granted, but not which later call used it.

## Scope

In scope:

- Approval outcome metadata for session allowance hits.
- Runtime trace/log event when a tool call is auto-approved because of a
  session allowance.
- Integration and service tests for the behavior.

Out of scope:

- Changing approval policy.
- Adding allowlist UI or productized management commands.
- MCP/skills/subagent/ACP productization.

## Requirements

- Existing auto-approved safe tools must not emit allowance-hit diagnostics.
- Risky shell calls matched by session allowances must emit
  `approval_auto_allowed`.
- Payload must include `source=session_allowance`, `tool_name`, `call_id`,
  `command_pattern`, `decision_id`, and `reason`.
- Workspace logs must record the same event at info level.
- The existing behavior of skipping a new pending decision must remain.

## Acceptance Criteria

- Approval service unit test distinguishes ordinary auto approval from session
  allowance auto approval.
- Integration test proves a second risky command after `allow_session` emits
  `approval_auto_allowed` trace/log and still avoids pending approval.
- Focused Python tests and ruff pass.

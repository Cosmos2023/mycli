# PRD: Approval Resolution Diagnostics

## Objective

Make approval resolution failures and terminal decisions diagnosable through local trace/log events. This strengthens Tool / Approval / Safety foundation without changing provider-visible behavior.

## Scope

Implement:

- A local-only `approval_resolution` diagnostic event.
- Trace/log emission for:
  - no pending decision
  - invalid choice
  - unavailable `allow_session`
  - user rejection
  - pending decision present but suspended turn missing
- Payload fields:
  - `result`: stable short string
  - `choice`: bounded user choice when available
  - `tool_name`
  - `call_id`
  - `decision_id`
  - `command_pattern`
  - `reason`
- Integration tests proving trace/log emission for at least invalid choice, rejection, and duplicate/no-pending response.

Do not implement:

- new approval UI
- policy changes
- provider transcript changes
- MCP/skills/subagent/ACP productization

## Acceptance Criteria

- Invalid approval choice keeps the pending decision and emits `approval_resolution` with `result=invalid_choice`.
- Rejection clears the pending decision and emits `approval_resolution` with `result=rejected`.
- Resolving when there is no pending decision emits `approval_resolution` with `result=no_pending_decision`.
- Diagnostics appear in runtime trace and workspace logs.
- Existing approval behavior and tests continue passing.
- Focused tests pass:
  - `tests/integration/test_turn_service.py`
  - ruff on changed files

## Risks

- Duplicate/no-pending diagnostics have no source decision. The payload should remain sparse rather than inventing a decision id.
- This is diagnostic-only. It must not change request shape, tool exposure, or provider-visible messages.

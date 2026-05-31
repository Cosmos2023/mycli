# Doctor Session State Recovery Payload Validation

## Problem

`mycli doctor` can currently report `sessions_db=ok` when the SQLite database
has the expected tables, valid foreign keys, and valid conversation lineage, but
critical recovery rows in `session_state` are corrupt or malformed.

This weakens session/state parity: a session may appear healthy until the user
tries to resume a pending approval, pending clarification, or interrupted turn.

## Scope

In scope:

- Validate critical recovery payloads in `session_state`.
- Surface bounded, actionable `sessions_db` failure details.
- Add doctor unit tests for invalid recovery payload rows.
- Update backend quality/database spec if a new diagnostic contract is added.

Out of scope:

- Automatic repair, prune, vacuum, or migration.
- Changing runtime recovery behavior.
- Productizing MCP/skills/subagent/ACP.
- Changing the DB schema.

## Requirements

- Doctor must fail `sessions_db` if a critical `session_state` row contains
  invalid JSON.
- Doctor must fail `sessions_db` if a critical state payload is not a JSON
  object.
- Doctor must fail `sessions_db` if `suspended_turn` has malformed
  `pending_approval` or `pending_clarification` objects that would prevent
  recovery.
- Failure messages must include bounded `session_id:state_key` references and
  must not dump raw payload JSON.
- Existing healthy DB, lineage, trace, log, and TUI dependency doctor tests must
  keep passing.

## Critical State Keys

- `pending_decision`
- `suspended_turn`
- `turn_record`
- `responses_continuation_state`

## Acceptance Criteria

- New doctor tests cover invalid JSON, non-object JSON, and malformed
  `suspended_turn` recovery state.
- `uv run pytest tests/unit/services/test_doctor_service.py -q` passes.
- Focused lint for doctor code passes.
- Trellis task is archived and committed on the feature branch.

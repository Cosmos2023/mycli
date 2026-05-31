# Doctor Recovery Payload Shape Hardening

## Goal

Make `mycli doctor` catch malformed waiting-state recovery payloads before a
resume/TUI flow reaches a broken approval or clarification response path.

## Requirements

- Doctor must keep opening the sessions DB read-only and must not repair state.
- `pending_decision` payload validation must require:
  - `tool_call` object with `name`, `arguments`, and `reason`
  - `kind` string
  - `preview` string
  - `options` list
- Suspended-turn `pending_approval` validation must require:
  - `tool_call` object with `name`, `arguments`, and `reason`
  - `reason` string
  - `preview` string
- Suspended-turn `pending_clarification` validation must require:
  - `tool_call` object with `name`, `arguments`, and `reason`
  - `request_id` string
  - `question` string
  - `options` list when present
  - `multi_select` boolean when present
- Diagnostics must remain bounded and must not print raw payloads, command
  strings, questions, user text, headers, or secret-like values.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not merge into `main`.

## Non-Goals

- Do not validate every enum value in this slice.
- Do not migrate or repair existing malformed rows.
- Do not change session persistence format.

## Acceptance Criteria

- New doctor tests fail before implementation for malformed-but-JSON-valid
  pending decision and suspended-turn pending clarification payloads.
- Doctor reports `sessions_db=failed` with bounded field-level details.
- Existing valid pending approval / clarification doctor tests keep passing.
- Relevant ruff, mypy, focused pytest, and Python full tests pass.
- Trellis task is archived and committed on the feature branch.

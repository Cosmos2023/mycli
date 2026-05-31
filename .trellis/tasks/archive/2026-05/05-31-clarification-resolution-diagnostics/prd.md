# Clarification Resolution Diagnostics

## Problem

Clarification requests are part of the Hermes-like runtime/TUI waiting-input
contract, but clarification responses do not currently produce local trace/log
diagnostics. Approval resolution already has this diagnostic loop; clarification
should have a matching foundation so no-pending and mismatched request-id
failures are diagnosable after the fact.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Session / State parity, Runtime event contract parity, and
Diagnostics / logs / trace / doctor parity for the clarification waiting state.

## Requirements

- Add local `clarification_resolution` trace rows and workspace log entries for
  `resolve_pending_clarification`.
- Record bounded result categories:
  - `answered`
  - `blank_response`
  - `no_pending_clarification`
  - `request_id_mismatch`
- Successful rows should include:
  - `request_id`
  - `tool_name`
  - `call_id`
  - `response_chars`
- Failure rows should include bounded diagnostic fields, but must not include
  raw user response text.
- Behavior must not change:
  - blank response still asks for a response;
  - no pending clarification still returns the existing assistant message;
  - mismatched `request_id` still returns the existing assistant message;
  - successful response still clears the suspended turn and resumes execution.
- Extend doctor with a `clarification_diagnostics` check:
  - missing traces or no rows -> `ok`;
  - successful answered rows -> `ok`;
  - failure result rows -> `warning`;
  - output must be bounded and must not print raw response text or user text.
- Update backend quality/logging specs.

## Acceptance Criteria

- Unit or integration test proves successful clarification response records a
  `clarification_resolution` trace row/log entry and still resumes execution.
- Unit or integration tests prove blank response, no pending clarification, and
  mismatched request id record bounded diagnostic rows without clearing state
  incorrectly.
- Doctor unit tests cover no rows, successful rows, and warning rows without raw
  response leakage.
- Focused checks pass:
  - `uv run pytest tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py tests/unit/services/test_doctor_service.py -q`
  - `uv run ruff check src/mycli/application/runtime/turn_executor.py src/mycli/services/diagnostics/doctor.py tests/unit/application/test_agent_runtime.py tests/integration/test_turn_service.py tests/unit/services/test_doctor_service.py`
  - `uv run mypy src/mycli/application/runtime/turn_executor.py src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No gateway event shape changes.
- No provider transcript shape changes.
- No new TUI UI.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.

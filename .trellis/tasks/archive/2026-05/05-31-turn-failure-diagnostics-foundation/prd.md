# Turn Failure Diagnostics Foundation

## Problem

`mycli` already persists failed turn records and emits gateway terminal events,
but local trace/log diagnostics do not have a unified `turn_failed` row. A
Hermes-like local agent foundation should make model and runtime failures
diagnosable from trace/log/doctor without requiring users to reconstruct the
failure from several unrelated artifacts.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Runtime event contract parity and Diagnostics / logs / trace /
doctor parity for terminal failed turns.

## Requirements

- Add local `turn_failed` trace rows and workspace log entries for failed
  non-interrupted turns finalized through the runtime error finalizer.
- Payload must be bounded and include:
  - `session_id`
  - `turn_id`
  - `stop_reason`
  - `phase`
  - `error_type`
  - `error_path` when available
- Payload must not include raw exception messages, traceback text, provider
  payloads, user text, tool output, headers, or secret-like values.
- Model errors should record `phase=model_request_failed` or the finalizer's
  model phase and preserve existing `TurnStatus.FAILED` / `StopReason`
  behavior.
- Runtime exceptions should record `phase=runtime_error` and preserve existing
  raw error payload and user-facing error-details behavior.
- Doctor must add `turn_failure_diagnostics`:
  - missing traces or no rows -> `ok`
  - rows present -> `warning`
  - output includes bounded total count, stop-reason counts, and phase counts
  - output must not print raw messages, tracebacks, request payloads, user text,
    headers, or secret-like values.
- No gateway event shape changes, provider transcript shape changes, TUI UI
  changes, MCP, skills, subagent, or ACP productization.

## Acceptance Criteria

- Runtime tests prove:
  - model errors append `turn_failed` trace/log diagnostics and still finalize
    as `TurnStatus.FAILED`;
  - runtime exceptions append `turn_failed` trace/log diagnostics and still
    write the existing raw error payload.
- Doctor tests cover:
  - missing trace directory;
  - no `turn_failed` rows;
  - model/runtime failure summaries;
  - no raw message/traceback/secret leakage.
- Backend logging and quality specs document the new diagnostic contract.
- Focused checks pass:
  - `uv run pytest tests/unit/application/test_agent_runtime.py tests/unit/services/test_doctor_service.py -q`
  - `uv run ruff check src/mycli/application/runtime/turn_error_finalizer.py src/mycli/services/diagnostics/doctor.py tests/unit/application/test_agent_runtime.py tests/unit/services/test_doctor_service.py`
  - `uv run mypy src/mycli/application/runtime/turn_error_finalizer.py src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No gateway or TypeScript protocol change.
- No new public slash command.
- No raw error payload format change.
- No automatic recovery policy change.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.

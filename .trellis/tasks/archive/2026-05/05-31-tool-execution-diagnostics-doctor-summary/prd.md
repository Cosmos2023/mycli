# Tool Execution Diagnostics Doctor Summary

## Problem

`mycli` records rich local `tool_execution` trace rows, but doctor does not
summarize them. A Hermes-like local agent foundation should make tool failures,
interruptions, denials, long output, and write-diagnostic problems visible from
the standard self-check path without requiring users to inspect raw trace JSONL.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Tool / approval / safety foundation and Diagnostics / logs /
trace / doctor parity.

## Requirements

- Add a read-only doctor check named `tool_execution_diagnostics`.
- Missing `~/.mycli/traces/` or no `tool_execution` rows must be `ok` with
  `no tool execution diagnostics found`.
- Successful-only tool rows must be `ok`.
- Failed tool rows must be `warning`.
- The summary must include bounded counts for:
  - total tool executions;
  - failed tool executions;
  - interrupted tool executions (`error_kind=tool_interrupted`);
  - denied tool executions (`error_kind=tool_denied_by_hook`);
  - stdout/stderr truncation flags;
  - write diagnostics errors.
- Details may include bounded `error_kind` counts, but must not print raw tool
  arguments, stdout, stderr, summaries, file contents, paths, user text, headers,
  or secret-like values.
- Invalid trace rows continue to be handled by the existing `traces` check; this
  check should skip malformed rows just like the stream/approval summaries.
- No runtime behavior, gateway event shape, provider transcript shape, or TUI
  rendering changes.

## Acceptance Criteria

- Doctor unit tests cover:
  - missing trace directory;
  - no `tool_execution` rows;
  - successful-only rows;
  - failed/interrupted/denied/truncated/write-diagnostics rows;
  - no raw payload or secret leakage in rendered output.
- Backend logging and quality specs document the new doctor summary contract.
- Focused checks pass:
  - `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
  - `uv run mypy src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No new runtime trace event kind.
- No gateway or TypeScript protocol change.
- No TUI rendering change.
- No automatic repair or cleanup.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.

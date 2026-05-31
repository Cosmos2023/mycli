# Doctor Stream Diagnostics Summary

## Problem

`mycli` now records `model_stream_diagnostics` trace rows, but `mycli doctor`
only reports generic trace validity. Users still need to manually inspect trace
JSONL to know whether recent model streams are healthy.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Diagnostics / Logs / Trace / Doctor parity by adding a
read-only doctor check for model stream diagnostics summaries.

## Requirements

- Add a `stream_diagnostics` doctor check.
- Check is read-only and must not create trace directories.
- Missing trace dir -> OK, `no stream diagnostics found`.
- Existing trace files with no `model_stream_diagnostics` rows -> OK, same
  message.
- Successful stream diagnostics -> OK summary with:
  - stream count
  - max TTFB ms
  - max elapsed ms
  - total text bytes
- Failed stream diagnostics -> WARNING summary with:
  - stream count
  - failure count
  - bounded failure kind details
- Reuse the same bounded trace-file scan limit as the generic trace check.
- Do not print raw trace payloads or failure messages in the doctor summary.

## Acceptance Criteria

- Unit tests cover:
  - missing trace directory
  - valid success stream diagnostics summary
  - failed stream diagnostics warning with bounded failure kind detail
  - no stream diagnostics rows
- Focused tests pass:
  - `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No automatic trace repair.
- No new trace file creation.
- No provider SDK header extraction.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.

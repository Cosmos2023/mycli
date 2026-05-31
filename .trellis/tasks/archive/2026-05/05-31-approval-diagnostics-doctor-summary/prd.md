# Approval Diagnostics Doctor Summary

## Problem

mycli records approval-resolution and session-allowance diagnostics to traces
and logs, but `mycli doctor` does not summarize them. When approval state gets
stuck, rejected, invalid, or silently auto-allowed by a session allowance, the
operator must inspect raw trace JSONL manually.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Tool / approval / safety foundation and Diagnostics / logs /
trace / doctor parity.

## Requirements

- Add a read-only doctor check named `approval_diagnostics`.
- The check scans existing trace JSONL files only; it must not create trace
  directories or mutate session/log state.
- Missing `~/.mycli/traces/` or no approval diagnostic rows must return `ok`.
- Count these trace kinds:
  - `approval_resolution`
  - `approval_allowance`
  - `approval_auto_allowed`
- Summarize total approval diagnostic rows and per-kind counts.
- For `approval_resolution`, summarize bounded result counts from payload
  `result`.
- Return `warning` if any non-successful approval-resolution result appears:
  - `no_pending_decision`
  - `invalid_choice`
  - `allow_session_unavailable`
  - `missing_suspended_turn`
  - any unknown non-empty result outside expected successful results
- Successful results are:
  - `approved`
  - `rejected`
- Summary/detail must not print raw payloads, command patterns, reasons, API
  keys, headers, or user text.
- Keep existing trace corruption handling unchanged. This check can ignore
  malformed rows already surfaced by the `traces` check.
- Update backend quality/logging specs with the new doctor behavior.

## Acceptance Criteria

- Unit test: missing trace directory reports `approval_diagnostics=ok`.
- Unit test: trace directory with no approval rows reports `ok`.
- Unit test: successful approval diagnostics summarize counts and stay `ok`.
- Unit test: invalid/missing approval resolution outcomes summarize bounded
  result counts and return `warning` without raw payload leakage.
- Focused checks pass:
  - `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
  - `uv run mypy src tests`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No approval behavior or policy changes.
- No gateway event changes.
- No raw trace export format changes.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.

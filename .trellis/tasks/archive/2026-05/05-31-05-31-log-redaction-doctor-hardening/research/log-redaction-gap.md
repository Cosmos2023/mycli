# Log Redaction Doctor Gap

Date: 2026-05-31

Baseline: `feature/mycli-foundation-hardening-audit`

Hermes reference: semantic maturity only. Do not copy Hermes code.

## Current Capabilities

- `WorkspaceLogService` centralizes operational logs and model-provider debug
  payloads.
- File layout:
  - `agent.log`
  - `errors.log`
  - `model-events.jsonl`
  - `model-raw/<session>/*.json`
- `WorkspaceLogService` redacts:
  - bearer tokens
  - OpenAI-style `sk-...` keys
  - assignment-shaped API key/token/secret/password text
  - nested JSON values whose keys are sensitive
- Existing unit tests prove newly written log lines and raw payloads are
  redacted before persistence.

## Gap

`mycli doctor` checks whether logs exist and are writable, but it does not
inspect existing logs for accidental secret leakage. A mature local agent should
be able to self-diagnose unsafe diagnostic artifacts after a bug, interrupted
run, or manual file copy.

The check must be careful:

- It must be read-only.
- It must not print secret values while reporting a leak.
- It must be bounded so large logs do not make doctor expensive.
- It must treat missing logs as the existing warning path, not a redaction
  failure.

## This Slice

Add a bounded `logs_redaction` doctor check that scans:

- `agent.log`
- `errors.log`
- `model-events.jsonl`
- a bounded number of `model-raw/**/*.json` files

The check reports:

- `ok` when scanned files contain no obvious secret patterns.
- `failed` when a probable leaked secret is found.
- `failed` when a selected log file cannot be read.

The detail must include only file/line references or file names, never the
matched secret text.

## Non-goals

- No log repair or automatic deletion.
- No full recursive unbounded scanning.
- No MCP/skills/subagent/ACP productization.
- No main merge.

## Verification

- `uv run pytest tests/unit/services/test_doctor_service.py tests/unit/services/test_workspace_log_service.py -q`
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
- `uv run mycli doctor`

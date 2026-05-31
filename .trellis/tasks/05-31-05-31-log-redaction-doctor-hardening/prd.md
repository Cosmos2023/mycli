# Log Redaction Doctor Hardening

## Problem

`mycli` writes local operational logs and model-provider debug payloads. The
writer redacts secrets, but `mycli doctor` cannot currently detect already
persisted leaked secrets. That leaves users without a local self-check when
debug artifacts are copied in, written by a prior bug, or manually edited.

Hermes-agent is the maturity reference for safe diagnostics. This task does not
copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Diagnostics / Logs / Trace / Doctor parity by adding a
read-only redaction leak check for existing log artifacts.

## Requirements

- Add a `logs_redaction` doctor check.
- The check must scan only bounded local diagnostics:
  - `agent.log`
  - `errors.log`
  - `model-events.jsonl`
  - a bounded number of files under `model-raw/`
- The check must not create, modify, delete, or repair log files.
- Missing logs remain covered by the existing `logs` warning and should not
  create a separate redaction failure.
- A probable leaked API key, bearer token, token assignment, secret assignment,
  password assignment, or nested raw payload secret must fail the check.
- Failure output must not include the leaked secret value.
- Valid redacted placeholders such as `[REDACTED]` must not be treated as leaks.
- Large files and large directories must be bounded.

## Acceptance Criteria

- Doctor unit tests cover:
  - clean logs -> `logs_redaction=ok`
  - leaked secret in `agent.log` -> `logs_redaction=failed`
  - leaked nested secret in `model-raw/**/*.json` -> `logs_redaction=failed`
  - missing logs dir -> no extra redaction failure
  - failure output does not contain the secret value
- Existing workspace log redaction tests still pass.
- Lint passes for changed files.
- `uv run mycli doctor` still runs successfully in the current environment.
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No automatic log repair.
- No log rotation implementation.
- No request dump feature.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.

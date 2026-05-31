# Trace Payload Redaction Hardening

## Problem

`mycli` trace rows are local diagnostics and can be exported as JSONL through
CLI and gateway surfaces. The current sanitizer removes large content from some
known fields but does not consistently redact nested secret-bearing fields or
secret-like text. A mature Hermes-like local agent foundation must keep trace
artifacts safe for inspection and external consumption.

Hermes-agent is the maturity reference. This task does not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Diagnostics / Logs / Trace / Doctor parity by hardening trace
payload sanitization before persistence and export.

## Requirements

- Trace sanitization must redact sensitive-key string values:
  - `authorization`
  - `api_key`
  - `apikey`
  - `x-api-key`
  - `token`
  - `access_token`
  - `refresh_token`
  - `secret`
  - `password`
- Trace sanitization must redact secret-like text in arbitrary strings:
  - bearer tokens
  - OpenAI-style keys
  - API-key/token/secret/password assignment text
- Nested dicts/lists/tuples must be sanitized recursively.
- Existing content-size sanitization must remain intact:
  - `raw_payload.content`
  - `transcript_content`
  - `current_user_request`
  - `instruction_contract`
- `export_jsonl()` must not expose the original secrets.
- Tests must prove both persisted trace files and exported rows are redacted.

## Acceptance Criteria

- Trace unit tests cover nested sensitive-key values and arbitrary secret-like
  strings.
- Existing content preview/count tests still pass.
- Doctor trace/log checks still pass.
- Lint passes for changed trace files.
- `uv run mycli doctor` still runs successfully.
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No trace repair/migration command.
- No new trace transport.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.

# Trace Redaction Doctor Coverage

## Problem

`mycli doctor` can validate trace JSONL structure and scan operational logs for
secret leaks, but trace files are not included in the redaction scan. A valid
trace row with an unredacted authorization header or token can pass diagnostics.

## Goal

Make doctor detect obvious secret leaks in runtime trace JSONL files without
printing raw trace payload content.

## Scope

- Include `~/.mycli/traces/*.jsonl` in the doctor redaction health check.
- Preserve the existing `traces` structural check and its bounded count/line
  reporting.
- Reuse existing sensitive-key and secret-like text detection where practical.
- Update backend diagnostic/logging specs to document trace redaction scan
  behavior.
- Add unit tests for trace redaction leaks and clean trace files.

## Non-Goals

- No trace migration or repair.
- No runtime event contract changes.
- No new logging dependency.
- No merge to `main`.

## Acceptance

- A valid trace JSONL row containing a nested unredacted bearer token or token
  field causes `logs_redaction=failed`.
- Doctor output reports only bounded relative trace file and JSON path/line
  references, never the secret value.
- Clean redacted trace files remain OK.
- Existing invalid trace row reporting remains unchanged.
- Relevant doctor/trace tests and lint pass.

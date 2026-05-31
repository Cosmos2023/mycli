# Trace Redaction Doctor Coverage Research

## Current State

- `DoctorService._check_traces()` validates `~/.mycli/traces/*.jsonl` shape and
  reports bounded file/line references for invalid rows.
- `DoctorService._check_logs_redaction()` scans `~/.mycli/logs/agent.log`,
  `errors.log`, `model-events.jsonl`, and `model-raw/<session>/*.json` for
  obvious secret leaks.
- `TraceService` sanitizes nested trace payloads before persistence and export,
  but doctor does not independently detect an already persisted unredacted
  secret in trace files.
- Existing specs require trace doctor output to avoid raw payloads and logging
  specs require secret-bearing trace/log data to be redacted before disk write.

## Gap

If a bug, old version, or external write leaves a raw bearer token/API key in a
trace JSONL row, `doctor` can still report `traces=ok` as long as the row is a
valid `RuntimeTraceEvent`. This weakens diagnostics parity with the log/model
raw redaction scan.

## Direction

Extend the existing doctor redaction scan to include bounded trace JSONL files.
Keep the check read-only, reuse existing secret detectors, and report only
bounded relative file/line or JSON-path references. Do not print secret values.

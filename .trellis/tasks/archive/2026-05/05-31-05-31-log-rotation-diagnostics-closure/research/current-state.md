# Log Rotation Current State

## Context

`WorkspaceLogService` centralizes local operational diagnostics under either
`<workspace>/log` for compatibility callers or `~/.mycli/logs` when injected
from runtime bootstrap. It writes:

- `agent.log` for INFO/WARNING/ERROR operational lines.
- `errors.log` for WARNING/ERROR operational lines.
- `model-events.jsonl` for redacted model event rows.
- `model-raw/<session>/*.json` for redacted request/response/error payloads.

Doctor already checks log path presence and scans operational logs, model raw
payloads, and trace JSONL files for obvious secret leaks.

## Gap

Operational log files append without a size cap. Long-running local agent
sessions can grow `agent.log`, `errors.log`, and `model-events.jsonl`
indefinitely, which weakens the diagnostics foundation compared with mature
Hermes-like local agents that bound local text logs with retained backups.

## Slice Direction

Add bounded size-based rotation to the centralized log writer while preserving
existing file names, redaction, session tags, and doctor behavior. Keep the
feature local and dependency-free; do not add logging framework complexity or
change raw model payload retention.

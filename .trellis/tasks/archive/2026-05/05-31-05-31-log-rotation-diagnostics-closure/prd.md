# Log Rotation Diagnostics Closure

## Problem

`mycli` has centralized, redacted operational logs, but text logs grow without
bound. A Hermes-like local agent foundation should keep operational diagnostics
usable during long-running sessions by rotating bounded log files while
preserving the existing three-file responsibilities.

## Scope

Implement a complete Diagnostics / Logs closure for bounded operational logs.

Included:

- Add size-based rotation for `agent.log`, `errors.log`, and
  `model-events.jsonl`.
- Preserve existing redaction before disk write.
- Preserve `agent.log` INFO+ and `errors.log` WARNING+ split.
- Preserve `inspect_logs()` output and make rotation status visible.
- Add unit tests for rotation, backup retention, errors split, model events,
  and redaction after rotation.
- Update logging spec with the local rotation contract.

Excluded:

- No time-based cleanup.
- No total-directory quota.
- No rotation for `model-raw/<session>/*.json` payload files.
- No new dependency or Python logging framework rewrite.
- No MCP/skills/subagent/ACP productization.

## Requirements

### A. Rotation Contract

- `WorkspaceLogService` rotates before appending when a write would exceed a
  configurable per-file byte limit.
- Default max size is conservative for production use.
- Default backup count retains a small bounded history.
- Backups use suffixes `.1`, `.2`, etc.
- Backup count `0` truncates the active file on overflow without keeping
  backups.

### B. Compatibility

- Existing constructor callers continue to work.
- Tests can inject small max size and backup count without changing global
  config.
- Redaction must happen before rotation/write.
- Warning/error entries still reach both `agent.log` and `errors.log`.
- Model event JSONL rows remain valid JSON after rotation.

### C. Diagnostics

- `inspect_logs()` must expose rotation settings in bounded key/value form.
- Doctor's existing log and redaction checks must remain compatible with
  rotated active files.

## Acceptance Criteria

- Unit tests prove `agent.log` rotates and retains bounded backups.
- Unit tests prove `errors.log` rotates independently while preserving the
  warning/error split.
- Unit tests prove `model-events.jsonl` rotates and active rows remain JSONL.
- Unit tests prove redacted values do not leak after rotation.
- Focused workspace log tests pass.
- Relevant ruff and mypy pass.
- Full Python tests pass.
- Node TUI tests/typecheck pass or are recorded if unrelated environment
  blocks them.
- Trellis task is archived and committed on the feature branch.

# Doctor Approval Safety Metadata Summary

## Problem

Approval diagnostics now carry bounded `safety_metadata`, but `mycli doctor`
does not summarize it. This leaves the safety foundation observable in trace
JSONL but not visible through the human diagnostic surface.

## Scope

Add a bounded doctor summary for approval `safety_metadata`.

Included:

- Count approval diagnostic rows that include valid `safety_metadata`.
- Aggregate allowlisted `risk_level` values.
- Aggregate bounded `policy` identifiers.
- Keep existing approval diagnostics behavior compatible.
- Add tests proving doctor does not print raw command patterns, reasons, tool
  arguments, paths, or secrets from trace payloads.

Excluded:

- No TUI rendering change.
- No runtime contract/schema change.
- No MCP, skills, subagent, multi-agent, or ACP productization.
- No raw trace dump in doctor.

## Requirements

### A. Summary Count

`approval_diagnostics` message must include `safety_metadata=<count>` when
approval diagnostics are present.

### B. Detail Aggregates

Doctor detail may include:

- `resolution_results: ...`
- `risk_levels: ...`
- `policies: ...`

Only aggregate counts may be shown.

### C. Sanitization

Doctor must not print:

- raw `command_pattern`
- raw `reason`
- raw tool arguments
- raw local paths
- secrets or secret-like values
- unknown nested payload fields

### D. Compatibility

Existing approval diagnostics status behavior remains:

- no rows -> OK
- successful rows -> OK
- problem resolution results -> WARNING
- unreadable trace files -> FAILED

## Acceptance Criteria

- Tests cover successful metadata summary.
- Tests cover problem approval diagnostics with metadata while proving raw
  payload values are not rendered.
- Relevant ruff, mypy, and pytest commands pass.
- Full Python test suite passes.
- Node TUI tests pass or are documented if unrelated environment failure occurs.
- Task is archived and committed on the feature branch.

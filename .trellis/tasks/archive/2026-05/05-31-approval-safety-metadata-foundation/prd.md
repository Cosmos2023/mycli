# Approval Safety Metadata Foundation

## Problem

`mycli` has approval and safety decisions, but the decision surface is mostly
human text. Hermes-like local agent foundations need safety decisions that are
machine-readable, traceable, and safe to summarize without exposing raw tool
arguments.

## Scope

Add a bounded `safety_metadata` foundation to the approval safety path.

Included:

- `SafetyPolicy.evaluate()` returns structured metadata with stable fields.
- `ApprovalService.evaluate()` carries the metadata into `ApprovalOutcome`.
- Approval allowance and auto-allow trace/log payloads include allowlisted
  metadata fields.
- Tests prove metadata exists for safe, denied, waiting-approval, and
  session-allowance flows.

Excluded:

- No MCP, skills, subagent, ACP productization.
- No new approval modes.
- No TUI rendering change in this slice.
- No doctor rendering of raw safety metadata in this slice.
- No raw arguments or full shell commands in diagnostics.

## Requirements

### A. Safety Metadata Contract

Every `ToolSafetyDecision` must expose `metadata: dict[str, object]` containing
bounded, non-secret, stable keys:

- `tool_name`: original tool name
- `canonical_tool_name`: policy-normalized tool name
- `risk_level`: `low`, `medium`, or `high`
- `decision_kind`: `auto_allow`, `needs_choice`, or `deny`
- `policy`: stable policy identifier

Shell evaluations may add:

- `command_pattern` when available

Workspace-boundary denials may add:

- `path_boundary`: `outside_workspace`

### B. Approval Outcome Propagation

`ApprovalOutcome` must carry `safety_metadata` for denied, pending, auto-allowed,
and session-allowance-approved decisions.

### C. Diagnostics Propagation

Local approval trace/log payloads for session allowance and auto-allowance must
include allowlisted `safety_metadata`. Existing payload keys remain compatible.

### D. Safety

Metadata must not include:

- raw tool arguments
- raw file contents
- full shell command strings beyond the existing sanitized `command_pattern`
- API keys, tokens, headers, or secret-like values

## Acceptance Criteria

- Unit tests cover metadata from `SafetyPolicy` for low-risk, denied shell,
  waiting shell, and workspace-boundary decisions.
- Unit tests cover `ApprovalService` metadata propagation for pending,
  denied, and session allowance outcomes.
- Integration tests cover approval diagnostic trace payload metadata for:
  - `approval_allowance`
  - `approval_auto_allowed`
- Relevant ruff, mypy, and pytest commands pass.
- Task is archived after verification.

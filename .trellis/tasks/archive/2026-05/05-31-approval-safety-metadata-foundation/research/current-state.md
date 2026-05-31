# Approval Safety Metadata Current State

## Context

Hermes-like local agent foundations need approval and tool safety decisions to be
observable without relying on free-form strings. `mycli` currently has a working
approval path, session allowance support, trace/log diagnostics, and doctor
summaries, but safety decisions expose only `reason`, `preview`, and
`command_pattern`.

## Current implementation

- `src/mycli/services/approval/safety_policy.py` classifies tools and evaluates
  calls into `ToolSafetyDecision`.
- `ApprovalService.evaluate()` turns `ToolSafetyDecision` into
  `ApprovalOutcome`.
- Pending approvals persist through `PendingApproval` /
  `PendingDecision`; these keep existing user-facing fields.
- Approval diagnostics are written as local trace/log rows:
  - `approval_allowance`
  - `approval_auto_allowed`
  - `approval_resolution`
- Doctor summarizes approval diagnostic counts but intentionally does not print
  raw command patterns or reasons.

## Gap

Safety decisions are not machine-readable enough for diagnostics and future
runtime clients. Consumers can tell that a decision happened, but cannot
distinguish stable dimensions such as risk level, decision kind, policy source,
canonical tool name, shell command pattern presence, or workspace-boundary
denial without parsing human text.

## Slice direction

Add bounded `safety_metadata` to approval safety decisions and outcomes. Keep
existing user-facing fields unchanged for compatibility. Include allowlisted
metadata in local approval trace/log payloads so future doctor/TUI/extension
work can summarize safety posture without raw arguments or secrets.

## Safety constraints

- Do not include raw tool arguments.
- Do not include full shell commands beyond the existing sanitized
  `command_pattern`.
- Do not include local file contents.
- Do not print raw metadata in doctor in this slice.
- Do not productize MCP, skills, subagents, or ACP.

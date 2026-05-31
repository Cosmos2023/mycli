# Medium Risk Tool Approval Safety Closure

## Problem

`mycli` has a config field named `auto_approve_medium`, but medium-risk tools
such as `Edit`, `Write`, and `KillShell` are currently auto-allowed by the
safety policy. This weakens Hermes-like safety parity because users cannot make
local file mutations require explicit approval.

## Scope

Implement a full capability closure for configurable medium-risk approvals.

Included:

- `SafetyPolicy` supports `auto_approve_medium`.
- `AgentRuntime` wires `AgentConfig.auto_approve_medium` into the default
  approval service.
- `Edit`, `Write`, and `KillShell` require approval when
  `auto_approve_medium=False`.
- Workspace-boundary denials remain denials, not approval requests.
- Pending decisions for file-write approvals expose only approve once / reject,
  not allow session.
- Existing gateway/TUI approval request and waiting status flows are exercised
  by integration tests.
- Doctor/trace diagnostics remain bounded and compatible.

Excluded:

- No MCP, skills, subagent, multi-agent, or ACP productization.
- No new TUI UI component.
- No broad redesign of approval storage.
- No new dependency.

## Requirements

### A. Policy behavior

- Default behavior remains compatible: medium-risk tools are auto-allowed.
- With `auto_approve_medium=False`, medium-risk tools return `NEEDS_CHOICE`.
- `reason`, `preview`, and `safety_metadata` must explain the policy without
  raw content.
- Denied workspace-boundary violations still return `DENY`.

### B. Runtime behavior

- A runtime built without an explicit `ApprovalService` must honor
  `AgentConfig.auto_approve_medium`.
- A `Write` request under strict medium approval must suspend the turn with a
  pending approval and must not execute the tool before approval.
- Approving once resumes and executes the tool.
- Rejecting emits the existing rejected terminal status.

### C. Gateway/TUI behavior

- Node TUI scripted client must observe a `Write` approval request via existing
  gateway events when medium auto-approval is disabled.
- The dumped TUI state must show pending approval / waiting approval before the
  response and the final answer after approval.

### D. Diagnostics behavior

- Approval diagnostics and doctor summaries should continue to pass with
  safety metadata.
- No raw file contents or local paths should be printed by doctor.

## Acceptance Criteria

- Unit tests cover `SafetyPolicy(auto_approve_medium=False)` for `Write`,
  `Edit`, `KillShell`, and workspace-boundary denial.
- Unit tests cover `ApprovalService` pending approval for medium-risk tools.
- Runtime/integration tests prove `Write` is not executed before approval and
  executes after approve once.
- Node scripted gateway smoke covers strict medium-risk `Write` approval.
- Relevant ruff, mypy, Python tests, and Node TUI tests pass.
- Task is archived and committed on the feature branch.

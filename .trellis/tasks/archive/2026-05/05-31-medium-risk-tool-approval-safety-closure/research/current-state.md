# Medium Risk Tool Approval Safety Current State

## Context

`AgentConfig` exposes `auto_approve_medium`, but the approval safety path does
not currently use it. `SafetyPolicy` auto-allows workspace-local `Edit`,
`Write`, and `KillShell` calls after workspace-boundary validation. That keeps
existing flows fast, but it leaves the runtime without a strict safety mode for
medium-risk local mutations.

## Current implementation

- `SafetyPolicy.evaluate()` classifies `Edit`, `Write`, and `KillShell` as
  medium risk, but returns `AUTO_ALLOW` for them when they are otherwise valid.
- `ApprovalService.evaluate()` only asks for user choice when
  `SafetyPolicy.evaluate()` returns `NEEDS_CHOICE`.
- `AgentRuntime` constructs `ApprovalService()` without wiring
  `AgentConfig.auto_approve_medium`.
- Gateway/TUI already support `approval.request`, `approval.respond`,
  `turn.status(waiting_approval)`, and scripted approval smokes.
- Doctor already summarizes approval diagnostics and safety metadata.

## Gap

Hermes-like local agent foundations need a configurable safety mode for local
mutating tools. The current field `auto_approve_medium` is present but inert,
so users cannot require approval for medium-risk file/shell-control operations.

## Slice direction

Make medium-risk tool approval configurable:

- Default `auto_approve_medium=True` remains backward compatible.
- When false, medium-risk `Edit`, `Write`, and `KillShell` return
  `NEEDS_CHOICE`.
- File-write approvals do not expose `allow_session` because they do not have a
  shell command pattern.
- Runtime, gateway/TUI, trace, and doctor should use the existing waiting
  approval and approval diagnostics surfaces.

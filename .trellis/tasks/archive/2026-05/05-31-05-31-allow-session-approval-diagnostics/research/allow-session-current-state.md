# Allow Session Approval Diagnostics

## Current behavior

- `DecisionAction.ALLOW_SESSION` adds a `SessionCommandAllowance` to session
  state.
- The allowlist changes subsequent approval behavior because matching risky
  shell commands are auto-approved for the session.
- The state is only visible by inspecting session internals. There is no
  explicit runtime trace event or operational log line recording that the user
  granted a session-scoped allowance.

## Gap

Hermes-like local agent foundations need safety decisions to be diagnosable.
When a later risky command is auto-approved because of a session allowance,
operators should be able to answer: which pattern was allowed, which tool call
created it, which turn created it, and whether the grant was newly added or
already present.

## Target

- When choice `3` / `allow_session` is accepted, runtime trace records an
  `approval_allowance` event.
- Workspace logs record a bounded `approval_allowance` info line with session
  and turn context.
- The behavior should not change policy semantics; it only makes the existing
  allowance observable.

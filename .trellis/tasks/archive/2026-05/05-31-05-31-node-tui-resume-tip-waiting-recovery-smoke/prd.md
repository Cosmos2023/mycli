# Node TUI Resume Tip Waiting Recovery Smoke

## Goal

Prove the Node TUI gateway foundation can recover waiting approval and
clarification state after resuming an ancestor session to its resolved lineage
tip.

## Requirements

- Add a scripted-client `session.resume` action.
- Use the real Node scripted client and Python gateway process boundary.
- Avoid external provider calls.
- Cover approval pending on a branch/tip resumed from root.
- Cover clarification pending on a branch/tip resumed from root.
- Verify `session.changed` / `status.changed` update Node state for the active
  tip before response actions are sent.
- Verify response actions clear pending state and produce terminal completed
  status.

## Non-Goals

- Do not change lineage resolution semantics unless a test exposes a bug.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not introduce interactive full-screen TUI testing.
- Do not merge into `main`.

## Acceptance Criteria

- The new scripted-client test fails before `session.resume` action support.
- Python gateway + real Node scripted-client integration tests pass for
  approval and clarification recovery after resume.
- Focused Node scripted-client tests pass.
- Node typecheck passes.
- Trellis task is archived and committed on the feature branch.

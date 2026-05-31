# Current State: Resume Tip Waiting-State Smoke

## Finding

Existing tests cover:

- `TurnService.resume_session("root")` resolves an ancestor to the latest
  descendant tip and rebinds runtime services.
- `AgentRuntime` can pause/resume pending approval and pending clarification
  within the active session.
- Node gateway emits status snapshots after `session.resume`.

There is still a gap in end-to-end local session behavior: no real
`TurnService` / `AgentRuntime` smoke proves that waiting state created on a
forked tip remains bound to that tip when a new service resumes from the root
ancestor.

## Desired Coverage

Use real `TurnService` and `AgentRuntime.for_tests` with a shared home directory:

1. Create root conversation.
2. Fork to branch/tip.
3. Create pending approval or pending clarification on the branch.
4. Construct a fresh service starting from root/default-style config.
5. Resume from root and prove active session becomes branch.
6. Resolve the pending state through the fresh service and prove root is not
   mutated as the active waiting state owner.

This is smoke coverage, not a product feature.

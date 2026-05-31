# Node TUI Resume Tip Waiting Recovery Smoke Current State

## Current Coverage

- `tests/integration/test_turn_service.py` covers service-level resume from a
  root session to the resolved lineage tip before approval and clarification
  resolution.
- `tests/unit/cli/node_tui/test_gateway.py` covers `session.resume` emitting
  `session.changed` followed by `status.changed`.
- `tui/node/test/reducer.test.ts` covers `status.changed` clearing stale
  pending approval and clarification state.
- Existing Python gateway plus real Node scripted-client tests cover waiting
  approval/clarification, but they start in the already-active session.

## Gap

There is no single real Node scripted-client smoke proving that `session.resume`
from an ancestor switches to the resolved tip and then allows pending approval
or clarification recovery in the resumed tip.

## Proposed Slice

- Extend the Node scripted client with a `session.resume` action.
- Add Python gateway integration tests that use a deterministic fake service
  with persisted pending state on a branch/tip.
- Drive real Node scripted client through `session.resume(root)` followed by
  `approval.respond` and `clarify.respond`.
- Verify dumped Node state is bound to the branch/tip and pending state is
  cleared after resolution.

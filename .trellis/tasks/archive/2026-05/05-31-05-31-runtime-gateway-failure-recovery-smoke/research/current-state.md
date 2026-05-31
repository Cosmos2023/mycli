# Runtime Gateway Failure Recovery Smoke Current State

## Current Coverage

- `tests/integration/test_node_tui_gateway.py` already runs the Python gateway
  against the real Node scripted client for typed streaming, waiting approval,
  clarification, approval rejection, tool lifecycle, and interruption.
- Those tests prove individual paths, but they do not prove a single long-lived
  Node client can recover from a failed turn and then continue through approval,
  clarification, tool failure, and interruption states.
- `tui/node/src/smoke/scriptedClient.ts` waits for terminal states after normal
  string turns and scripted approval / clarification / interruption actions.
- Gateway errors and request failures are already reduced into error transcript
  rows, but the existing scripted-client test only covers a direct request
  failure, not a runtime turn failure followed by successful later work.

## Gap

Hermes-like local agent foundation needs recovery confidence across the same
runtime client session. A failed turn should not poison subsequent pending
approval, clarification, tool lifecycle, or interrupted-turn flows.

## Proposed Slice

Add one bounded integration smoke using a fake service plus the real Node
scripted client:

1. Submit a turn that returns a terminal failed `TurnRecord`.
2. Submit a turn that enters approval wait and reject it.
3. Submit a turn that enters clarification wait and resolve it.
4. Submit a turn that emits one successful and one failed tool lifecycle.
5. Submit an interrupt action and verify interrupted terminal state.

The test should inspect the dumped Node state for one coherent transcript,
terminal live status, cleared pending state, preserved error/tool rows, and no
duplicate assistant final text.

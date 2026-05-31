# Scripted Terminal State Assertions

## Problem

The Node scripted smoke client can submit turns and respond to approvals or
clarifications, but it cannot declare the expected runtime/TUI state for a turn.
This weakens future Hermes-like contract hardening because tests have to infer
whether a script reached `failed`, `waiting_approval`, `waiting_clarification`,
`rejected`, or `completed` by inspecting dumped state after the run.

## Goals

- Add a reusable `turn.submit_expect` scripted action.
- Let real Node smoke scripts assert expected runtime/TUI states while driving
  the actual JSON-RPC gateway.
- Cover failed and waiting-state paths with the new action.
- Keep the action small and test-oriented; do not create a product surface.

## Non-Goals

- Do not add MCP, skills, subagent, multi-agent, or ACP behavior.
- Do not change runtime event semantics.
- Do not copy Hermes code.
- Do not replace existing script actions.

## Requirements

1. `MYCLI_NODE_TUI_SCRIPT` may include:
   ```json
   {
     "type": "turn.submit_expect",
     "message": "fail once",
     "expected_state": "failed"
   }
   ```
2. The action must submit the turn with a generated `client_turn_id`.
3. For `waiting_approval`, it must wait until the reducer has a pending
   approval and live status reaches `waiting_approval`.
4. For `waiting_clarification`, it must wait until the reducer has a pending
   clarification and live status reaches `waiting_clarification`.
5. For terminal states `completed`, `failed`, `interrupted`, and `rejected`, it
   must wait until the matching runtime/TUI status is observed.
6. The action must fail loudly if an unsupported `expected_state` is provided.
7. Tests must cover:
   - Node-only scripted-client request/event behavior.
   - Real Python gateway + Node scripted client for failed, waiting approval,
     and waiting clarification states.

## Acceptance

- New scripted-client unit test fails before implementation and passes after.
- New real Node gateway integration smoke passes for failed and waiting states.
- Existing Node scripted smokes continue passing.
- Full Python and Node TUI tests/typecheck pass.

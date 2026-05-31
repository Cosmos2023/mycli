# Scripted Terminal State Assertions Current State

## Current Coverage

The real Node scripted client already drives several gateway paths:

- normal typed stream completion
- approval waiting and approve/reject responses
- clarification waiting and responses
- wrong approval id request failure
- tool lifecycle
- interrupted turns
- late normal completion after interrupt suppression
- recovery matrix across failed, rejected, clarification, tool lifecycle, and
  interrupted turns

## Gap

String script entries submit turns but only wait for generic completion/pending
routing. Tests then inspect dumped state after the fact. This makes scripted
smokes less reusable for future runtime contract work because scripts cannot
declare the expected runtime/TUI state inline.

There is no script action that says:

```json
{"type":"turn.submit_expect","message":"fail once","expected_state":"failed"}
```

and waits until the matching runtime/TUI status is observed. Without this, each
new terminal/waiting-state smoke has to hand-roll assertions around the dumped
state.

## Desired Direction

Add a small scripted-client action that submits a turn with a generated
`client_turn_id` and waits for the expected Hermes-like runtime state:

- `waiting_approval`
- `waiting_clarification`
- `completed`
- `failed`
- `interrupted`
- `rejected`

The action should keep using gateway events and reducer state, not an in-process
test-only API. It should be useful for real Python gateway integration tests and
Node-only scripted-client tests.

## Relevant Specs

- `.trellis/spec/backend/runtime-tui-gateway-contract.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`

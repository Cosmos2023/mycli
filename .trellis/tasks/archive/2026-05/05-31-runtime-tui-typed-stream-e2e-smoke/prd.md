# Runtime TUI Typed Stream End-to-End Smoke

## Goal

Add a real automated smoke test for the runtime-to-Node-TUI typed stream path.
The smoke should run the Python gateway against the real Node scripted client,
not just unit-test the two sides independently.

## Context

- Runtime emits `message.delta`, `message.complete`, `reasoning.delta`, and
  `thinking.delta` alongside compatibility `turn.event`.
- Node TUI reducer consumes typed message deltas and suppresses duplicate
  same-turn legacy assistant deltas.
- Existing Node tests cover reducer behavior in-process.
- Existing Python gateway tests cover emitted methods in-process.
- Missing proof: a cross-process run where Python gateway writes JSON-RPC
  notifications to the real Node client and the Node reducer ends with the
  correct visible state.

## Requirements

- Exercise `run_node_tui_gateway(...)` with a real `NodeTuiProcess`.
- Use the real Node scripted client entrypoint.
- Use a deterministic fake runtime service that emits:
  - reasoning stream event
  - assistant text delta stream events
  - model completion stream event
  - final `TurnResponse`
- Verify the Node side receives and reduces the stream without duplicating
  assistant text from compatibility `turn.event`.
- Verify reasoning/thinking text is not mixed into the assistant answer body.
- Avoid real provider/model calls.
- Avoid modifying persistent user session state.
- Keep the smoke bounded and suitable for CI.

## Non-Goals

- Do not run an interactive full-screen TUI.
- Do not call an external model provider.
- Do not remove unit tests.
- Do not merge into `main`.

## Acceptance Criteria

- New integration test runs Python gateway + real Node scripted client.
- Test asserts process exit code is `0`.
- Test asserts final Node state contains one assistant final answer with the
  authoritative final answer.
- Test asserts streamed duplicate text did not appear in the final answer.
- Test asserts reasoning preview does not pollute answer text.
- Python focused test passes.
- Node typecheck and test suite still pass.
- Work is committed and archived on `feature/mycli-tui-runtime-smoke` only.

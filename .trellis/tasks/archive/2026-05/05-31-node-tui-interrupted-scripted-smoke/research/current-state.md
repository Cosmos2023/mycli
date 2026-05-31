# Current State: Node TUI Interrupted Scripted Smoke

## Goal

Add a real Node scripted smoke path that proves the TUI gateway client can submit a turn, request interruption while the gateway reports a running turn, and reduce the resulting terminal interrupted state without stale live-turn state.

## Existing Behavior

- `src/mycli/cli/node_tui/gateway.py` supports the `turn.interrupt` RPC.
- `NodeTuiGateway._handle_turn_interrupt()` emits:
  - `turn.interrupted`
  - `turn.status(state="interrupted", terminal=true)`
  - `status.update(state="interrupted")`
- `tui/node/src/state/reducer.ts` treats `interrupted` as a terminal state and clears live turn bookkeeping.
- `tui/node/test/reducer.test.ts` already covers reducer behavior for `turn.status(state="interrupted")`.
- `tests/unit/cli/node_tui/test_gateway.py` covers direct Python gateway interrupt handling while a fake service is running.

## Gap

The real Node scripted client cannot currently trigger an interrupt during a running turn. Script entries that are plain strings call `turn.submit` and then wait for turn completion before the next scripted action runs. Existing scripted actions only support approval and clarification responses after the gateway has already entered a waiting state.

## Implementation Direction

- Add a scripted action that submits a turn and immediately calls `turn.interrupt`, then waits for an interrupted terminal status.
- Add a real Node scripted gateway integration test with a fake blocking service so the interrupt request races against a deterministic running turn instead of relying on timing against a fast completed turn.
- Verify the dumped reducer state shows:
  - `liveStatus.state == "interrupted"`
  - `turnRunning == false`
  - `currentTurnId == null`
  - no pending approval or clarification

## Risks

- The gateway interrupt notification currently omits `client_turn_id` because the handler does not track the currently running client turn id under lock. The smoke should reveal whether the scripted client can still consume this state. A later contract-hardening slice may choose to bind interrupt payloads to the active `client_turn_id`.
- The worker thread may later emit completed state after an interrupt if the underlying service ignores cancellation. The current gateway contract documents interruption as an interrupt request, not guaranteed worker cancellation.

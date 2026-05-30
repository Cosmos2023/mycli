# Waiting-State Scripted Client Research

## Files Inspected

- `tui/node/src/smoke/scriptedClient.ts`
- `tui/node/src/app/App.tsx`
- `tui/node/src/state/reducer.ts`
- `src/mycli/cli/node_tui/gateway.py`
- `tests/integration/test_node_tui_gateway.py`
- `tests/unit/cli/node_tui/test_gateway.py`
- `.trellis/spec/backend/runtime-tui-gateway-contract.md`

## Findings

- Production Ink input already routes pending clarification submits to
  `clarify.respond` and numeric approval choices through `ApprovalPrompt`.
- The scripted client bypasses `App.tsx` and currently only supports string
  script items. Strings are enough for local slash commands and plain turns,
  but not for explicit approval/clarification response actions.
- The reducer already stores active `pendingApproval` and
  `pendingClarification` from gateway notifications.
- Gateway `approval.respond` and `clarify.respond` requests return an accepted
  response containing a resolution `client_turn_id`, then emit a worker
  `turn.completed` for that id.
- Waiting-state scripted actions should therefore:
  1. read `decision_id` or `request_id` from current reducer state,
  2. send the matching JSON-RPC request,
  3. reduce the notification events as usual,
  4. wait for `turn.completed` with the returned `client_turn_id`.

## Test Shape

Add a Python integration test using the real Node entrypoint with a script like:

```json
[
  "needs approval",
  { "type": "approval.respond", "choice": "approve_once" },
  "needs clarification",
  { "type": "clarify.respond", "response": "Runtime" }
]
```

The fake service can return:

- `TurnResponse(..., pending_decision=PendingDecision(...))` for the approval
  trigger.
- A `RuntimeStreamEvent(kind="clarify_request", metadata={...})` plus a
  `TurnResponse` carrying a `TurnRecord(status=WAITING_CLARIFICATION)` for the
  clarification trigger.
- Completed assistant messages for the resolution workers.

Assertions should cover service-level calls, final reducer state, and visible
transcript content.

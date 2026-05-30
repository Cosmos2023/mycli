# Node TUI Waiting-State Scripted Smoke

## Problem

The real Node scripted-client smoke now covers local commands and one normal
typed gateway turn, but it still cannot express user actions that happen after
the runtime enters a waiting state. Hermes-like parity depends on approval and
clarification routes being reliable across the real JSON-RPC gateway, not just
inside reducer or gateway unit tests.

## Goal

Extend the scripted smoke harness with explicit test-only actions for waiting
states, then add real Node scripted-client integration coverage for:

1. A user turn that emits `approval.request` / `waiting_approval`.
2. A scripted approval response sent through `approval.respond`.
3. A user turn that emits `clarify.request` / `waiting_clarification`.
4. A scripted clarification response sent through `clarify.respond`.
5. Final reducer state proving pending approval and clarification are cleared
   after resolution.

## Non-Goals

- Do not change production keyboard handling or the Ink app.
- Do not change runtime/gateway event semantics.
- Do not add a new persisted session or log format.
- Do not copy Hermes code; only match the semantic shape of the contract.

## Acceptance Criteria

- `tui/node/src/smoke/scriptedClient.ts` supports object script items for
  test-only waiting-state actions:
  - `{ "type": "approval.respond", "choice": "approve_once" }`
  - `{ "type": "clarify.respond", "response": "Runtime" }`
- The scripted client derives the active `decision_id` / `request_id` from
  reducer state instead of hardcoding transport ids in tests.
- The scripted client waits for the corresponding resolution turn to complete
  before continuing.
- Python integration tests run the real Node entrypoint and assert the fake
  service received the approval choice and clarification answer.
- The final state dump proves waiting-state UI state was cleared and visible
  transcript rows were updated without duplicate assistant output.
- Existing string script behavior remains compatible.

## Risks

- Scripted smoke actions must remain clearly test-oriented; production TUI input
  behavior stays in `App.tsx`.
- The gateway returns accepted responses before worker completion, so the
  scripted client must wait for terminal events with the returned
  `client_turn_id` to avoid races in the final state dump.
- Fresh worktrees may lack Node dependencies; verification may need the same
  temporary `node_modules` copy workaround used by previous TUI slices.

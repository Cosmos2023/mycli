# Clarify Respond Contract

## Goal

Complete the first real `clarify.request` -> `clarify.respond` loop so a Node TUI user can answer an `AskUserQuestion` clarification and the Python runtime can resume the paused turn with that answer as the tool result.

## Context

- `AskUserQuestion` currently returns a successful tool result with `status = "awaiting_user_response"`.
- The runtime emits `clarify.request`, and the Node TUI stores/renders `pendingClarification`.
- The current TUI display slice deliberately does not send `clarify.respond`.
- Approval already has a real suspend/resume model through `PendingDecision`, `SuspendedTurn`, and `TurnExecutor.resolve_pending_approval(...)`.
- Clarification is not approval: it is low-risk user input for the model, not a safety decision.

## Requirements

- Add a domain representation for pending clarification that captures:
  - `request_id`
  - source `ToolCall`
  - question/options/header/multi-select fields needed for diagnostics and UI validation
- Persist pending clarification inside the existing suspended-turn state.
- When `AskUserQuestion` produces `awaiting_user_response`, pause the turn after emitting the normal tool lifecycle and `clarify.request`, save the suspended turn, and return a waiting clarification turn response.
- Add runtime/service/gateway handling for `clarify.respond`:
  - Required payload: `request_id`, `response`
  - Optional payload: selected option labels or indexes for future TUI affordances
  - Validate the request matches the active pending clarification.
  - Resume the suspended turn by appending the user answer as the original `AskUserQuestion` tool result and continuing the loop.
- Emit `clarify.respond` as a gateway notification after a response is accepted, and mirror it via `runtime.event`.
- TUI must be able to send a plain text answer when `pendingClarification` exists. For this slice, treat normal input submit as the clarification answer while pending clarification exists.
- Reducer must clear `pendingClarification` when `clarify.respond` is observed.
- Update `.trellis/spec/backend/runtime-tui-gateway-contract.md` with concrete request/response/event contract details.
- Do not merge into `main`.

## Non-Goals

- No rich form UI, arrow-key option picker, multi-select editor, or numeric shortcut polish.
- No cross-session handoff routing for clarification ownership beyond persisted suspended-turn state.
- No Hermes source code copying.
- No broad runtime refactor unrelated to clarification suspend/resume.

## Acceptance Criteria

- Unit tests prove `SuspendedTurn` persists and reloads pending clarification.
- Runtime tests prove an `AskUserQuestion` pauses with a pending clarification and `resolve_pending_clarification(...)` resumes to final assistant output.
- Gateway tests prove `clarify.respond` validates request id, starts a resolving turn, emits `clarify.respond`, and returns accepted response metadata.
- Node tests prove input submit sends `clarify.respond` instead of `turn.submit` while a clarification is pending and reducer clears pending state on `clarify.respond`.
- Python targeted tests pass.
- Node typecheck and focused Node tests pass.
- Trellis task is archived and work is committed only on `feature/mycli-clarify-respond-contract`.

## Risks

- If `AskUserQuestion` is treated like a normal successful tool forever, the model may continue without the user answer. The fix must pause the turn, not only emit a UI event.
- If TUI reuses approval paths, clarification could inherit safety-decision keybindings incorrectly.
- If resume does not preserve provider tool-call `call_id`, Responses-style tool result continuation can break.

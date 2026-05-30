# Clarify Respond Contract Research

## Existing Runtime Shape

- `AskUserQuestionTool` returns `ToolResult(success=True, summary="Awaiting user response", raw_payload={..., status="awaiting_user_response"})`.
- `ToolExecutionService._clarify_request_event(...)` converts that result into `RuntimeStreamEvent(kind="clarify_request")`; gateway forwards it as `clarify.request`.
- Current tool execution still records the result as a normal tool message and the main turn loop continues. That means a true response contract needs an explicit pause path, not just a request handler.

## Existing Suspend/Resume Pattern

Approval already provides the safest local model:

- Assistant block consumer detects pending approval before tool execution.
- It saves `PendingDecision` plus `SuspendedTurn(user_message, conversation, plan_state, pending_approval)`.
- It finalizes the current turn with `TurnStatus.WAITING_APPROVAL` / `StopReason.APPROVAL_REQUIRED`.
- `TurnExecutor.resolve_pending_approval(...)` validates choice, reconstructs the suspended state, executes/injects the tool result, and resumes `_run_turn_loop(...)`.

Clarification should reuse the suspended-turn persistence shape but must not reuse `PendingDecision`, approval choices, or command allowances.

## Proposed Minimal Contract

- Add `PendingClarification` domain dataclass next to approval domain concepts or runtime turn state.
- Extend `SuspendedTurn` with `pending_clarification: PendingClarification | None`.
- Add `StopReason.CLARIFICATION_REQUIRED` and `TurnStatus.WAITING_CLARIFICATION` only if the contract needs terminal status separation. Existing Node `TurnState` union currently lacks `waiting_clarification`; adding it is useful for typed status parity but expands UI status handling.
- On AskUserQuestion await result, save suspended turn with conversation before the final clarification tool result is recorded as a normal answer. The resume method should inject a tool result using the same `call_id` as the original tool call, preserving Responses `function_call_output` semantics.
- Gateway request: `clarify.respond` with `{ request_id: string, response: string, selected_options?: string[] }`.
- Gateway event: `clarify.respond` with `{ client_turn_id, request_id, response }`, response bounded for UI/diagnostics.

## TUI Minimal UX

- While `state.pendingClarification` exists, normal text submit should call a new `onClarification(requestId, response)` callback instead of `onSubmit` / `turn.submit`.
- Do not add option keybindings yet. The user can type an option label or free text.
- Keep the visible row from the previous slice and status metadata `clarification pending`.

## Test Targets

- `tests/unit/services/test_session_service.py`: pending clarification round trip.
- `tests/unit/application/test_agent_runtime.py`: model asks question, runtime pauses; resolving injects answer and completes.
- `tests/unit/cli/node_tui/test_gateway.py`: request validation and worker start/event emission.
- `tui/node/test/*.test.tsx`: submit routing and reducer clear behavior.

## Boundaries

This slice should not design a full clarification form or platform handoff. It only makes the existing visible request actionable and resumes the runtime with a typed answer.

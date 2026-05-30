# Runtime TUI Gateway Contract

> Contract for Python runtime events consumed by the Node TUI.

## Scenario: Approval And Live Status Events

### 1. Scope / Trigger
- Trigger: Any change to `src/mycli/cli/node_tui/gateway.py`, the Node TUI
  protocol types, or the reducer state that changes runtime-to-TUI events.
- This is a cross-layer contract. Python owns runtime semantics and JSON-RPC
  emission; TypeScript owns rendering and reducer state.
- The target direction is Hermes-like channel separation, but existing mycli
  JSON-RPC method-name notifications remain compatible until a versioned
  envelope migration is introduced.

### 2. Signatures
- Python event emitter:
  `NodeTuiGateway._emit_event(method: str, params: dict[str, object]) -> None`
- Turn submit request method: `turn.submit`
- Approval response request methods:
  - Preferred: `approval.respond`
  - Compatibility: `decision.resolve`
- P1 server notification methods:
  - `turn.started`
  - `status.update`
  - `approval.request`
  - `approval.respond`
  - `tool.start`
  - `tool.complete`
  - `tool.failed`
  - `message.delta`
  - `message.complete`
  - `reasoning.delta`
  - `thinking.delta`
  - `turn.completed`
  - `turn.failed`
  - `turn.interrupted`
  - `status.changed`
- TypeScript reducer entry point:
  `reduceShellState(state: ShellState, action: ShellAction) -> ShellState`

### 3. Contracts
- `status.update` payload:
  - `state`: one of `running`, `waiting_approval`, `completed`, `failed`,
    `interrupted`
  - `kind`: renderable status kind, normally the same as `state`
  - `text`: human-readable short status
  - `client_turn_id`: optional string linking the status to the submitted turn
  - `severity`: optional string for future warning/error display
- `approval.request` payload:
  - `decision_id`: stable string for the pending approval, currently
    `decision_current`
  - `client_turn_id`: string for the turn that produced the approval request
  - `preview`: human-readable operation preview
  - `reason`: optional human-readable rationale
  - `tool_name`: optional tool name
  - `options`: array of `{choice, label}` rows matching runtime
    `DecisionAction` values
- `approval.respond` request payload:
  - `decision_id`: must match the active decision id
  - `choice`: preferred Hermes-like choice string, such as `approve_once`,
    `reject`, or `allow_session`
- `decision.resolve` remains accepted for older clients. It shares the same
  gateway path as `approval.respond`.
- `turn.completed` must include `turn_state`. A response with
  `pending_decision` maps to `waiting_approval`; otherwise it maps to
  `completed`.
- Tool lifecycle notifications come from real tool execution, not model-side
  tool-call request streaming:
  - `tool.start` payload includes `client_turn_id`, `tool_id`, `call_id`,
    `name`, compact `context`, and optional bounded `args_preview`.
  - `tool.complete` payload includes `client_turn_id`, `tool_id`, `call_id`,
    `name`, `duration_s`, bounded `summary`, and `success: true`.
  - `tool.failed` payload includes the same completion fields with
    `success: false` and optional bounded `error`.
  - `tool_id` is the model/provider `call_id` when available; runtimes may use
    a deterministic local fallback when a call id is absent.
  - Lifecycle payloads are UI/diagnostic signals only. They must not be written
    into provider transcript content or stable request-shape inputs.
- Message and reasoning stream notifications are typed gateway projections of
  runtime model stream events:
  - `message.delta` is emitted for assistant text deltas and includes
    `client_turn_id` and bounded raw `text`.
  - `reasoning.delta` is emitted for reasoning chunks and includes
    `client_turn_id` and bounded raw `text`.
  - `thinking.delta` is emitted as a compatibility alias for the same current
    reasoning chunks. It must not invent separate model semantics while mycli
    only has one reasoning stream.
  - `message.complete` is emitted for model stream completion metadata and
    includes `client_turn_id` plus bounded metadata from the runtime stream
    event.
  - For this slice, `message.complete` is not the authoritative final assistant
    message. Final assistant text remains in `turn.completed.assistant_message`.
  - Existing generic `turn.event` notifications must continue to be emitted
    alongside these typed message/reasoning notifications until Node TUI
    clients have migrated.
- Reducer state:
  - `liveStatus` is driven by `status.update` and terminal turn events.
  - `pendingApproval` is driven by `approval.request`.
  - `pendingApproval` is cleared by `approval.respond`, terminal status, or a
    `status.changed` snapshot with `pending_decision === false`.
  - `tool.start`, `tool.complete`, and `tool.failed` are consumed by the Node
    TUI reducer as `tool_summary` transcript rows. The reducer matches existing
    rows by `tool_id` first and `call_id` second, so completion updates the
    running row instead of appending duplicates.
  - `tool.complete` maps the matching row to `status: "done"` and
    `tool.failed` maps it to `status: "failed"`. If completion arrives without
    a prior start, the reducer creates a compact fallback row.
  - `message.delta` is consumed as assistant stream text.
  - After a `message.delta` has been seen for a `client_turn_id`, the reducer
    ignores compatibility `turn.event` assistant deltas for that same
    `client_turn_id` to prevent duplicate visible answer text.
  - If no typed `message.delta` has been seen for the turn, legacy
    `turn.event` assistant deltas remain a valid fallback for older runtimes.
  - `reasoning.delta` and `thinking.delta` update compact live reasoning state
    for running-turn display. They must not append text to assistant answer
    transcript items.
  - Terminal turn events clear live reasoning and typed-message bookkeeping.

### 4. Validation & Error Matrix
- Unknown approval `decision_id` -> JSON-RPC error; do not resolve anything.
- Unknown or legacy approval choice -> map through the existing decision choice
  table; reject invalid choices at the runtime decision boundary.
- Invalid `status.update.state` in the reducer -> ignore the event and preserve
  existing state.
- Turn starts -> emit `turn.started` and live `status.update` with `running`.
- Turn returns `pending_decision` -> emit `approval.request`, then
  `turn.completed` with `turn_state=waiting_approval`, then `status.update`
  with `waiting_approval`.
- Tool execution starts -> emit `tool.start` during the running turn before the
  local tool is executed.
- Tool execution succeeds -> emit `tool.complete` during the running turn after
  the local `ToolResult` is known.
- Tool execution returns an unsuccessful `ToolResult` -> emit `tool.failed`
  during the running turn after the local `ToolResult` is known. Do not also
  emit `tool.complete` for the same failed result.
- Model reasoning chunk -> emit `reasoning.delta`, `thinking.delta`, and the
  compatibility `turn.event` with phase `reasoning`.
- Model assistant text chunk -> emit `message.delta` and the compatibility
  `turn.event` with phase `assistant_delta`.
- Node TUI receives both typed and compatibility assistant chunks for a typed
  runtime -> render only the typed `message.delta` content.
- Node TUI receives only legacy assistant chunks -> render
  `turn.event phase=assistant_delta` content.
- Model stream completion metadata -> emit `message.complete` and the
  compatibility `turn.event` with phase `model_completed`.
- Turn completes without a pending decision -> emit `turn.completed` with
  `turn_state=completed`, then `status.update` with `completed`.
- Turn raises -> emit `turn.failed`, then `status.update` with `failed`.
- User interrupt while a turn is running -> emit `turn.interrupted`, then
  `status.update` with `interrupted`.

### 5. Good/Base/Bad Cases
- Good: TUI renders a concrete approval prompt from `approval.request` without
  inferring details from transcript text.
- Good: TUI renders active tool rows from `tool.start` and final summaries from
  `tool.complete` / `tool.failed` without waiting for `turn.completed`.
- Good: TUI keeps a single row for the same tool id as it moves from running to
  done or failed.
- Good: New clients consume `message.delta` and `reasoning.delta` while older
  clients keep rendering from `turn.event`.
- Good: TUI shows a compact running reasoning preview without mixing reasoning
  text into the final assistant answer.
- Good: Running activity prefers `liveStatus.text`, so the status line can show
  `Waiting approval`, `Resolving approval`, or `Failed`.
- Base: Older clients still send `decision.resolve` and receive compatible
  behavior.
- Bad: Only setting `pending_decision: true` on `turn.completed`; that tells the
  UI a gate exists but not how to render or resolve it.
- Bad: Treating model-side `RuntimeStreamEvent(kind="tool_call")` as execution
  start. That event only means the model requested a tool.
- Bad: Rendering both typed `message.delta` and compatibility `turn.event`
  assistant deltas in the same TUI path, causing duplicate text.
- Bad: Treating `message.complete` as final assistant content before the
  runtime emits `turn.completed`.
- Bad: Sending full file contents, raw tool JSON, or provider transcript
  messages through lifecycle notification payloads.
- Bad: Appending a new visible row on both `tool.start` and `tool.complete` for
  the same `tool_id`; that creates duplicated tool activity.
- Bad: Adding new untyped event fields in Python without updating TypeScript
  payload types and reducer tests.
- Bad: Copying Hermes implementation code. Use Hermes only as the semantic
  reference for channel separation.

### 6. Tests Required
- Gateway unit test for `approval.request` payload fields and option mapping.
- Gateway unit test proving `approval.respond` and `decision.resolve`
  compatibility.
- Tool execution unit tests for start, complete, and failed lifecycle sink
  events without changing normal `TurnItemType.TOOL_CALL` / `TOOL_RESULT`
  recording.
- Agent runtime test proving lifecycle events flow through
  `handle_user_turn(..., stream_sink=...)` from real execution.
- Gateway unit test proving `RuntimeStreamEvent(kind="tool_start" |
  "tool_complete" | "tool_failed")` emits `tool.start` / `tool.complete` /
  `tool.failed`, not generic `turn.event`.
- Reducer/transcript tests proving Node TUI consumes `tool.start`,
  `tool.complete`, and `tool.failed` into one matched `tool_summary` row.
- Rendering/formatter tests proving lifecycle rows show readable running, done,
  and failed summaries with bounded details.
- Reducer tests proving Node TUI consumes `message.delta`, suppresses duplicate
  compatibility assistant deltas for the same turn, and preserves legacy
  `turn.event` fallback when typed deltas are absent.
- Reducer/rendering tests proving `reasoning.delta` and `thinking.delta` update
  compact live reasoning state without mutating assistant answer text.
- Gateway unit test proving `RuntimeStreamEvent(kind="text_delta")` emits
  `message.delta` and still emits compatibility `turn.event`.
- Gateway unit test proving `RuntimeStreamEvent(kind="reasoning")` emits
  `reasoning.delta`, `thinking.delta`, and still emits compatibility
  `turn.event`.
- Gateway unit test proving `RuntimeStreamEvent(kind="completed")` emits
  `message.complete` and still emits compatibility `turn.event`.
- Gateway tests for `status.update` on running, waiting approval, completed,
  failed, and interrupted paths when those paths are changed.
- Reducer unit test for `approval.request`, `approval.respond`,
  `status.update`, and terminal clearing behavior.
- Rendering test proving live status text is displayed instead of a hardcoded
  running label when present.
- Run Python gateway tests, `ruff`, `mypy` for the changed gateway file, Node
  `typecheck`, and Node tests for protocol/reducer/rendering changes.

### 7. Wrong vs Correct

Wrong:
```python
self._emit_event(
    "turn.completed",
    {"pending_decision": response.pending_decision is not None},
)
```

Correct:
```python
if response.pending_decision is not None:
    self._emit_event("approval.request", approval_payload)
self._emit_event("turn.completed", {"turn_state": "waiting_approval"})
self._emit_event("status.update", {"state": "waiting_approval", "text": "Waiting approval"})
```

Wrong:
```typescript
if (action.method === "status.update") {
  return { ...state, liveStatus: action.params as LiveStatus };
}
```

Correct:
```typescript
if (action.method === "status.update") {
  const liveStatus = liveStatusFromParams(action.params);
  return liveStatus ? { ...state, liveStatus } : state;
}
```

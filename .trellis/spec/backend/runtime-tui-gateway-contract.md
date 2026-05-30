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
- Trace export request method: `trace.export`
- Approval response request methods:
  - Preferred: `approval.respond`
  - Compatibility: `decision.resolve`
- P1 server notification methods:
  - `turn.started`
  - `status.update`
  - `approval.request`
  - `approval.respond`
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
- `trace.export` is a read-only pull RPC for machine-readable runtime trace
  rows:
  - Request payload accepts optional `tail`; invalid or non-positive values use
    the gateway default.
  - Response payload includes `session_id`, `format: "jsonl"`, and `rows`.
  - `rows` contains unprefixed JSONL row strings from the active session trace.
  - The slash command `/trace-jsonl` may prefix these rows for human command
    output, but RPC consumers must receive raw row strings.
- Reducer state:
  - `liveStatus` is driven by `status.update` and terminal turn events.
  - `pendingApproval` is driven by `approval.request`.
  - `pendingApproval` is cleared by `approval.respond`, terminal status, or a
    `status.changed` snapshot with `pending_decision === false`.

### 4. Validation & Error Matrix
- Unknown approval `decision_id` -> JSON-RPC error; do not resolve anything.
- Unknown or legacy approval choice -> map through the existing decision choice
  table; reject invalid choices at the runtime decision boundary.
- Invalid `status.update.state` in the reducer -> ignore the event and preserve
  existing state.
- Turn starts -> emit `turn.started` and live `status.update` with `running`.
- `trace.export` -> return bounded sanitized JSONL rows without mutating trace
  files or session state.
- Turn returns `pending_decision` -> emit `approval.request`, then
  `turn.completed` with `turn_state=waiting_approval`, then `status.update`
  with `waiting_approval`.
- Turn completes without a pending decision -> emit `turn.completed` with
  `turn_state=completed`, then `status.update` with `completed`.
- Turn raises -> emit `turn.failed`, then `status.update` with `failed`.
- User interrupt while a turn is running -> emit `turn.interrupted`, then
  `status.update` with `interrupted`.

### 5. Good/Base/Bad Cases
- Good: TUI renders a concrete approval prompt from `approval.request` without
  inferring details from transcript text.
- Good: Running activity prefers `liveStatus.text`, so the status line can show
  `Waiting approval`, `Resolving approval`, or `Failed`.
- Good: External/extension clients call `trace.export` instead of scraping
  human `/trace` or prefixed `/trace-jsonl` command output.
- Base: Older clients still send `decision.resolve` and receive compatible
  behavior.
- Bad: Only setting `pending_decision: true` on `turn.completed`; that tells the
  UI a gate exists but not how to render or resolve it.
- Bad: Adding new untyped event fields in Python without updating TypeScript
  payload types and reducer tests.
- Bad: Returning `[trace-jsonl]` prefixes from `trace.export`; those are only
  for slash command transcript output.
- Bad: Copying Hermes implementation code. Use Hermes only as the semantic
  reference for channel separation.

### 6. Tests Required
- Gateway unit test for `approval.request` payload fields and option mapping.
- Gateway unit test proving `approval.respond` and `decision.resolve`
  compatibility.
- Gateway tests for `status.update` on running, waiting approval, completed,
  failed, and interrupted paths when those paths are changed.
- Gateway unit test proving `trace.export` returns unprefixed JSONL rows and
  honors bounded `tail` behavior.
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

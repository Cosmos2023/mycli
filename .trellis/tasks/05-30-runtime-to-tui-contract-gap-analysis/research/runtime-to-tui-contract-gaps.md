# Runtime-to-TUI Event/Status Contract Gap Analysis

## Scope

This analysis compares mycli's current runtime-to-Node-TUI contract with the Hermes Agent reference in `/Users/cosmos/Desktop/mycli/hermes-agent`. The goal is Hermes-like contract parity in semantics, not a small local bug patch. It focuses on event/status semantics, payload shape, TUI state transitions, and gaps likely to block Hermes-grade live UX.

The runtime branch boundary is a shared runtime event contract. TUI is the first consumer, but the same event semantics should later serve subagents, MCP/ACP adapters, skills/tools, session logs, replay, resume, search, and debug dumps.

## Current mycli Contract

### Runtime Emits

- `RuntimeStreamEvent` is a loose dataclass with `kind: str`, `text`, `tool_name`, and `metadata`.
- `ModelTurnRequester` emits stream events for:
  - `reasoning`
  - `text_delta`
  - `tool_call`
  - `completed`
- `TurnResponse` carries final `assistant_message`, `activity_events`, `streamed_chunks`, `progress_updates`, `plan_steps`, `pending_decision`, and optional `turn`.
- Runtime persistence has stronger enums (`TurnStatus`, `StopReason`, `TurnItemType`) than the live stream contract, but the live Node TUI path does not expose most of that structure.

### Python Node Gateway Emits

- Startup emits `runtime.ready` with `_status_payload()`.
- Turn submit emits:
  - `turn.started`
  - repeated `turn.event`
  - `turn.completed` or `turn.failed`
  - final `status.changed`
- `turn.event` payload includes `client_turn_id`, `phase`, `kind`, `text`, `tool_name`, and `metadata`.
- `_phase_for_stream_event()` maps runtime kinds to `reasoning`, `assistant_delta`, `tool_call`, `heartbeat`, and `model_completed`.
- `turn.completed` includes final message plus `activity_events`, `progress_updates`, `plan_steps`, `pending_decision: bool`, and `usage: {}`.
- `_status_payload()` includes session/workspace/model/provider/context-window plus `pending_decision` and `suspended_turn` booleans.

### Node TUI Consumes

- `GatewayEvent` is just `RpcNotification`; event payloads are untyped `Record<string, unknown>`.
- Reducer handles:
  - `turn.started`
  - `turn.event` only for `phase === "assistant_delta"` and `phase === "tool_call"`
  - `turn.completed`
  - `approval.pending`
  - `status.changed`
  - `turn.failed`
- Reducer ignores `reasoning`, `heartbeat`, and `model_completed` stream phases.
- `RunningActivity` always displays `Thinking` plus the last tool trail derived from transcript `tool_summary` items.
- `ApprovalPrompt` expects `pendingApproval` with `decision_id`, `preview`, and `options`, but the gateway does not emit that shape.

## Hermes Reference Pattern

Hermes documents the same ownership split mycli is moving toward: TypeScript owns the screen; Python owns sessions, tools, model calls, and slash command logic. Its key TUI surfaces are explicitly mapped:

- `prompt.submit` -> `message.delta` / `message.complete`
- tool activity -> `tool.start` / `tool.progress` / `tool.complete`
- approvals -> `approval.request` then `approval.respond`
- status -> `status.update`
- theming -> `gateway.ready`

Hermes event envelope:

- Python writes JSON-RPC messages with `method: "event"`.
- The event body uses `params.type`, `params.session_id`, and optional `params.payload`.
- The TypeScript side has a `GatewayEvent` discriminated union covering gateway, session, status, reasoning, tool, approval, subagent, message, and error events.

Hermes live UX has distinct event channels:

- `thinking.delta` and `reasoning.delta` update reasoning/status separately from assistant text.
- `message.delta` and `message.complete` manage streamed assistant content and finalization.
- `tool.start`, `tool.progress`, and `tool.complete` carry tool id, name, context, args/result summaries, duration, inline diffs, and todos.
- `status.update` carries `kind` plus `text` and can become transient status, activity note, warning, process note, or goal note.
- `approval.request`, `clarify.request`, `sudo.request`, and `secret.request` are explicit overlay events.
- `subagent.*` events have a typed payload and terminal status protection.

## Gaps

### 1. Approval Contract Is Internally Inconsistent

Evidence:

- Node reducer handles `approval.pending`.
- `ApprovalPrompt` expects `decision_id`, `preview`, and `options`.
- Python gateway only sets `pending_decision: bool` in `turn.completed` and `status.changed`.
- Python gateway handles `decision.resolve` with fixed `decision_id == "decision_current"`.

Impact:

- The TUI can know that approval exists, but it cannot render actionable approval details unless some unobserved path emits `approval.pending`.
- The approval prompt can call `decision.resolve`, but the state needed to show options is not populated by the gateway.

Recommended fix:

- Emit a typed `approval.pending` event when a `TurnResponse.pending_decision` exists, including `decision_id`, `preview`, `reason`, and option rows matching `DecisionAction`.
- Clear `pendingApproval` on `decision.resolve`, `turn.completed`, or `status.changed` with `pending_decision: false`.
- Add gateway and reducer tests.

### 2. Live Event Taxonomy Is Too Loose

Evidence:

- Python `RuntimeStreamEvent.kind` is a free string.
- TypeScript `GatewayEvent` is any JSON-RPC notification.
- Reducer switches on raw method/phase strings.
- Runtime already has stronger enums for persisted turn status and turn items, but not for live TUI events.

Impact:

- Producer and consumer can drift silently.
- Adding new runtime event kinds will not fail type checks.
- Tests assert a few ordered events, but not an exhaustive contract.

Recommended fix:

- Add a Python-side event contract module for Node TUI events, with dataclasses or typed builders for `TurnStarted`, `TurnDelta`, `ToolStarted`, `ApprovalPending`, `StatusChanged`, `TurnCompleted`, and `TurnFailed`.
- Add TypeScript discriminated unions mirroring the emitted payloads.
- Keep the transport as JSON-RPC, but make payload creation typed and testable.

### 3. Reasoning, Heartbeat, and Model Completion Are Dropped

Evidence:

- Gateway maps `reasoning`, `heartbeat`, and `completed` to phases.
- Reducer only handles `assistant_delta` and `tool_call` phases inside `turn.event`.
- Python Textual TUI at least refreshes execution status for reasoning/heartbeat/completed.
- Hermes handles thinking/reasoning as first-class status/detail channels.

Impact:

- Node TUI live status stays generic and loses meaningful progress signals.
- Heartbeats cannot prevent stale-looking long turns.
- Completion metadata is ignored until final `turn.completed`.

Recommended fix:

- Decide whether mycli keeps `turn.event` with phases or splits events into `thinking.delta`, `status.update`, `tool.start`, etc.
- Minimal slice: handle `reasoning`, `heartbeat`, and `model_completed` in the reducer by updating live status and optional activity.
- Better slice: split status/reasoning from assistant text following Hermes' channel separation.

### 4. Tool Lifecycle Is Collapsed To Tool-Call-Only

Evidence:

- Runtime emits `tool_call` when the model requests a tool.
- Tool execution service creates `ActivityEvent(kind="tool_started" | "tool_finished", ...)` after execution.
- Node gateway only streams model-side `tool_call`; execution-side `activity_events` arrive at `turn.completed`.
- Hermes emits `tool.start`, `tool.progress`, and `tool.complete` during execution, including duration and result summaries.

Impact:

- Node TUI cannot show accurate live tool completion, durations, errors, or inline diff/result details during a long turn.
- Running activity can only infer path from `tool_summary` transcript items.
- Multiple tool calls in one turn become a shallow list without lifecycle pairing.

Recommended fix:

- Introduce live tool lifecycle events from the execution layer to the gateway, not only model adapter events.
- Include stable `tool_id`/`call_id`, `name`, `context`, optional `args_preview`, `result_summary`, `error`, `duration_s`, and mutation metadata when available.
- Keep final `activity_events` for transcript persistence, but do not rely on final response for live UI.

### 5. Status Payload Mixes Snapshot State With Live Status

Evidence:

- `_status_payload()` is a snapshot of session/model/provider/context plus pending/suspended booleans.
- `status.changed` is emitted only after a turn worker finishes.
- Runtime progress updates and plan steps are included only in `turn.completed`.
- Hermes uses `status.update` as a live, typed status channel with `kind` and `text`.

Impact:

- Node TUI status cannot distinguish "thinking", "running tool", "waiting approval", "compressing", "failed", "interrupted", or "ready" from snapshot fields alone.
- `RunningActivity` hardcodes `Thinking` regardless of actual phase.

Recommended fix:

- Keep `status.inspect` / `status.changed` for snapshots.
- Add live `status.update` events with at least `kind`, `text`, `client_turn_id`, and optional `severity`.
- Drive `RunningActivity` from live status instead of hardcoded "Thinking".

### 6. Final Turn Status Loses Runtime Stop Semantics

Evidence:

- Runtime has `TurnStatus` and `StopReason`.
- Gateway emits `turn.completed` for all successful `handle_user_turn()` returns, even when response contains `pending_decision`.
- `turn.failed` only covers Python exceptions in the worker.
- Completion payload does not include `turn.status`, `stop_reason`, or error details.

Impact:

- UI cannot distinguish completed, waiting approval, interrupted, loop-stopped, retry-exhausted, model-error, or transport-failed turns unless these are encoded as plain text elsewhere.
- Recovery/suspended-turn UX remains weak.

Recommended fix:

- Project `TurnResponse.turn.status` and `stop_reason` when available.
- If no `TurnRecord` exists, derive a conservative completion status from `pending_decision`, `error_details`, and worker state.
- Add reducer handling for terminal states and suspended-turn prompts.

### 7. Session Event Envelope Is Less Future-Proof Than Hermes

Evidence:

- mycli uses JSON-RPC notification method names directly.
- Hermes wraps all server events under `method: "event"` and puts event type/session id/payload under params.
- Hermes client filters by `session_id` before handling most events.

Impact:

- Current mycli protocol is fine for a single active session, but harder to extend to multiple live sessions, sidecar mirrors, or event logs.
- It also makes TypeScript event typing harder because every notification method is a separate RPC shape rather than a single event envelope.

Recommended fix:

- Do not change this first unless multi-session live events are in scope.
- If changed, keep backward compatibility with current method-named notifications for one protocol version and introduce `protocol_version: 2`.

## Recommended Implementation Sequence

### P1: Approval + Status

- Emit `approval.request` with actionable fields.
- Accept `approval.respond`.
- Add `status.update` for live runtime status.
- Expose turn state values: `running`, `waiting_approval`, `completed`, `failed`, and `interrupted`.
- Clear approval state when resolved or no longer pending.
- Update `RunningActivity` to use status text/kind.
- Tests: gateway payload tests, reducer tests, approval prompt flow test.
- Constraint: even though this slice is small, event names and payload shape must be Hermes-like and forward-compatible, not temporary fields.

### P2: Tool Lifecycle Streaming

- Emit `tool.start`, `tool.progress`, `tool.complete`, and `tool.failed`.
- Carry `tool_id`/`call_id`, `name`, `args_preview`, `result_summary`, `duration_s`, and risk/approval metadata.
- Preserve final `activity_events` for transcript/history.

### P3: Assistant/Reasoning Stream

- Emit `message.delta` and `message.complete`.
- Emit `thinking.delta` and `reasoning.delta`.
- Normalize provider-specific reasoning before it reaches the TUI.

### P4: Typed Envelope

- Add a unified event envelope with `event_id`, `session_id`, `turn_id`, `timestamp`, `type`, `payload`, and `seq`.
- Support replay, dedupe, resume, and debug dumps.
- Add Python event builders plus TypeScript discriminated unions.
- Add fixture-style contract tests that exercise encode/decode across Python and TypeScript sample payloads.

### P5: Terminal/Runtime Status

- Emit `turn.started`, `turn.completed`, `turn.failed`, `turn.interrupted`, and `turn.waiting_approval`.
- Emit `clarify.request` and accept `clarify.respond`.
- Include `turn_status`, `stop_reason`, and error details in final events.
- Render waiting approval, interrupted, and failed states distinctly.
- Add suspended-turn resume affordance later if needed.

## Target Direction

Adopt Hermes' channel separation as the target contract:

- Assistant text: `message.delta` / `message.complete` or current `turn.event(assistant_delta)` / `turn.completed`.
- Reasoning/status: dedicated status/reasoning events.
- Tool lifecycle: dedicated tool events.
- Human input gates: dedicated approval/clarify events.
- Snapshot status: separate inspect/change payload.

The transport envelope can be migrated deliberately, but the semantic target should remain Hermes-like from P1. Approval/status is first because it is visible, low-coupling, and validates the contract direction. It must not be implemented as one-off fields that later have to be replaced.

This design benefits three downstream lines:

- TUI does not infer runtime state from transcript strings.
- Extension surfaces such as MCP, subagents, skills, and tools can attach to one lifecycle model.
- Session/log infrastructure can persist envelopes for resume, replay, search, and debugging.
- ACP adapters can reuse the same semantics instead of inventing a parallel event taxonomy.

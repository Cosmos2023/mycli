# Runtime Tool Lifecycle Contract

## Goal

Add the next Hermes-like runtime-to-TUI contract slice: live tool lifecycle
events emitted from real tool execution, not only model-side tool-call
requests or final `activity_events`.

## Context

- The previous P1 contract added `approval.request`, `approval.respond`, and
  `status.update`.
- Goal priority says runtime contract comes before TUI rendering.
- Hermes reference emits `tool.start`, `tool.progress`, and `tool.complete`
  from tool execution callbacks.
- mycli currently streams model-side `RuntimeStreamEvent(kind="tool_call")`
  through `turn.event`, while execution-side tool start/result information is
  mostly appended to final `TurnResponse.activity_events`.

## Requirements

- Preserve existing JSON-RPC method-name notifications and current events:
  - `turn.event`
  - `turn.completed.activity_events`
  - `status.update`
- Add Hermes-like notification methods emitted by `NodeTuiGateway` during a
  running turn:
  - `tool.start`
  - `tool.complete`
  - optionally `tool.failed` when a completed tool result is unsuccessful
- Emit lifecycle events from the real execution path, using existing
  `ToolExecutionService` start/outcome points.
- Payloads must include stable fields:
  - `client_turn_id`
  - `tool_id` or `call_id`
  - `name`
  - compact `context` or preview text
  - optional `args_preview`
  - `duration_s` for completion when known
  - `summary` for completion
  - `success` for completion
  - optional `error` for failed tools
- Keep payloads bounded and safe:
  - no full file contents
  - no raw tool JSON dumps
  - use previews/summaries already present in `ToolResult` or bounded
    argument previews
- Keep runtime execution behavior unchanged:
  - tool ordering
  - approval behavior
  - provider transcript content
  - session persistence
  - request-shape/cache behavior
- Add or update tests proving:
  - `ToolExecutionService` can notify tool start and completion/failed events
    without changing tool result recording
  - `NodeTuiGateway` forwards lifecycle events to JSON-RPC notifications
  - existing gateway events still pass

## Non-Goals

- Do not implement Node TUI rendering of `tool.start` / `tool.complete` in this
  task. That is the next TUI worktree slice.
- Do not add `message.delta`, `message.complete`, `thinking.delta`, or
  `reasoning.delta`.
- Do not migrate the event envelope to Hermes' unified `method: "event"`.
- Do not copy Hermes implementation code.
- Do not change real tool execution semantics.

## Acceptance Criteria

- Runtime code has a typed or clearly structured lifecycle callback/event path
  from `ToolExecutionService` to `NodeTuiGateway`.
- Gateway emits `tool.start` and `tool.complete` notifications for a tool that
  actually executes.
- Failed tool results are represented distinctly either through `tool.failed`
  or through `tool.complete` with `success=false`; the choice is documented.
- Relevant Python tests pass:
  - unit tests for tool execution lifecycle callback
  - unit/integration tests for node TUI gateway lifecycle emission
  - existing node TUI gateway tests
- Trellis spec `.trellis/spec/backend/runtime-tui-gateway-contract.md` is
  updated with the new contract.
- Work is committed on `feature/mycli-runtime-capabilities` only. Do not merge
  into `main` unless the user explicitly asks.

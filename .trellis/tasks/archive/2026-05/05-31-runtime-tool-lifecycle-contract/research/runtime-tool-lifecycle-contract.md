# Runtime Tool Lifecycle Contract Research

## Current mycli Findings

- `RuntimeStreamEvent(kind="tool_call")` is model-side. It means the model
  requested a tool, not that the runtime started or completed execution.
- `NodeTuiGateway._forward_stream_event()` maps model-side `tool_call` to
  `turn.event` with `phase="tool_call"`.
- `TurnResponse.activity_events` includes execution-side activity such as
  `tool_started` and `tool_finished`, but those are only included in the final
  `turn.completed` payload.
- `ToolExecutionService.execute_tool_call()` is the real execution point:
  - normalizes the call
  - records a start `ActivityEvent`
  - records a `TurnItemType.TOOL_CALL`
  - executes through `tool_router.execute()`
  - records outcome through `_record_tool_outcome()`
  - appends contributed-tool lifecycle events afterward
- `ToolExecutionService` already measures `execution_started_at` with
  `monotonic()`, so completion duration can be computed without changing tool
  semantics.
- Parallel safe tools go through `_execute_parallel_batch()` and
  `_execute_tool_call_isolated()`. The lifecycle design must not assume a
  single sequential tool only.

## Hermes Reference Findings

- Hermes TUI gateway emits:
  - `tool.start` with `tool_id`, `name`, and `context`.
  - `tool.progress` for lightweight progress/preview updates.
  - `tool.complete` with `tool_id`, `name`, optional `duration_s`, `summary`,
    optional verbose result text, todos, and inline diffs when available.
- Hermes keeps `tool.complete` as the source of truth for final tool summaries.
- Tool progress can be configured/filtered per platform, but the event shape is
  separate from assistant text and approval overlays.

## Recommended P2 Shape

- Add a runtime-local tool lifecycle callback to `ToolExecutionService`.
- Emit at least two events:
  - start before `tool_router.execute()`
  - complete/failed after `ToolResult` is known
- Keep the first payload small:
  - `tool_id`: `ToolCall.call_id` if present, otherwise a deterministic fallback
  - `name`: normalized tool name
  - `context`: existing start activity message or a compact preview
  - `args_preview`: bounded string from safe argument keys
  - `duration_s`: rounded float
  - `summary`: `ToolResult.summary`
  - `success`: `ToolResult.success`
  - `error`: bounded `ToolResult.error` only when unsuccessful
- Gateway should translate lifecycle callback events into JSON-RPC
  notifications and include the active `client_turn_id`.

## Risks

- Parallel tool execution can call callbacks from worker threads. The gateway
  emitter must tolerate concurrent notifications.
- Argument previews must stay bounded and should not include full file content.
- Lifecycle events must remain local UI/diagnostic signals and must not feed
  provider transcript or request-shape construction.

# Current State

## Existing Behavior

- Turn-level `KeyboardInterrupt` handling exists in `TurnExecutor` and records
  interrupted turn diagnostics after suspended state is saved.
- `ToolExecutionService` emits Hermes-like tool lifecycle start/progress/final
  events for normal success, failed `ToolResult`, hook denial, and validation
  errors.
- `ToolExecutionService.execute_tool_call()` only converts `ValueError` from
  `tool_router.execute(...)` into a failed `ToolResult`. A `KeyboardInterrupt`
  raised while a tool is executing propagates before `_record_tool_outcome()`.

## Gap

When a tool is interrupted, the turn can be finalized as interrupted by the
outer runtime, but the tool that was running does not get a matching failed
tool lifecycle event, turn item, or `tool_execution` trace row. This leaves a
diagnostic gap in the Tool / Approval / Safety foundation: a trace reader can
see that a turn was interrupted but not which tool was in flight.

## Chosen Slice

Record a local, bounded failed tool outcome for `KeyboardInterrupt` in the
single-tool execution path, then re-raise the original interrupt so existing
turn-level interruption handling remains authoritative.

The synthetic result should use `error_kind=tool_interrupted`, preserve the
stable tool id/call id, emit `tool.failed`, append a `TOOL_RESULT` turn item,
and append a `tool_execution` trace row with `status=failed`.

This slice does not implement async cancellation, OS signal handling, parallel
batch cancellation, or TUI visual changes.

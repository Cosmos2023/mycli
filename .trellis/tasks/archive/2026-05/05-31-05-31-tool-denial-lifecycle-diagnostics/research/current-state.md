# Tool Denial Lifecycle Diagnostics Research

## Current State

- `ToolExecutionService.execute_tool_call()` runs `PRE_TOOL_USE` hooks before
  appending a `TOOL_CALL` turn item or emitting lifecycle `tool.start`.
- A `HookAction.DENY` becomes a failed `ToolResult` with
  `error_kind=tool_denied_by_hook` and is recorded into the provider transcript.
- Existing tests prove the underlying tool is not executed and the provider
  transcript receives a denied tool output.
- Successful and validation-failed tool executions already emit lifecycle
  `tool_start`, `tool_progress`, and `tool_complete`/`tool_failed`, plus a
  `tool_execution` trace row.

## Gap

When a safety hook denies a tool before execution, UI/gateway consumers can miss
the attempted tool call because the denial bypasses the normal tool-call start
path. That weakens Hermes-like tool lifecycle parity: high-risk tool denials
should be visible as a failed tool lifecycle, not only as hidden transcript
content.

## Direction

Record a bounded `TOOL_CALL` item and emit `tool_start` before returning the
denied failed outcome. Reuse `_record_tool_outcome()` so `tool_failed` lifecycle
events and `tool_execution` trace rows stay consistent with other failures.
Do not execute the underlying tool or create mutation snapshots for denied
calls.

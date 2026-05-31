# Tool Denial Lifecycle Diagnostics

## Problem

Pre-tool safety hooks can deny a tool before execution, but that path does not
emit the same observable lifecycle start/failure signals as other tool
failures. A TUI or future extension can therefore miss why a requested tool did
not run.

## Goal

Make pre-tool hook denials visible as a normal failed tool lifecycle and trace
diagnostic while preserving the safety guarantee that the underlying tool is
not executed.

## Scope

- For `HookAction.DENY`, append a bounded `TOOL_CALL` turn item.
- Emit `tool_start`, `tool_progress`, and `tool_failed` through the lifecycle
  sink for denied calls.
- Preserve existing provider transcript behavior: a failed tool output is still
  recorded for the denied call.
- Preserve trace behavior: denied calls append one `tool_execution` row with
  `status=failed` and `error_kind=tool_denied_by_hook`.
- Do not run the underlying tool, file-history snapshots, or write diagnostics
  for denied calls.

## Non-Goals

- No approval policy rewrite.
- No new user-facing approval mode.
- No Node TUI visual redesign.
- No merge to `main`.

## Acceptance

- Unit test proves a denied tool emits lifecycle events
  `tool_start -> tool_progress -> tool_failed`.
- Unit test proves denied lifecycle metadata includes stable `tool_id`/`call_id`,
  bounded summary/error, `success=false`, and the hook message.
- Unit test proves denied calls append a `TOOL_CALL` and a `TOOL_RESULT` item.
- Unit test proves denied calls append a failed `tool_execution` trace row with
  `error_kind=tool_denied_by_hook`.
- Existing denial behavior still proves the actual tool was not executed.

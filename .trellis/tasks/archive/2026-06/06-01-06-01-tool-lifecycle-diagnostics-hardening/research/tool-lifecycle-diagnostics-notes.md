# Tool Lifecycle Diagnostics Notes

## Current state

- `ToolExecutionService` emits `tool_start`, `tool_progress`,
  `tool_complete`, and `tool_failed` stream events.
- It appends `tool_execution` trace rows and doctor summarizes those rows.
- Older constants still know about the original read/search/lint and file
  mutation set.

## Target

Keep the existing runtime contract and improve coverage for the expanded built-in
toolset:

- classify GitStatus/GitDiff/GitLog/GitShow as safe read-only parallel tools
- classify Patch as a mutation fallback
- add bounded trace previews for arguments, summary, and error
- surface error_kind in failed lifecycle events

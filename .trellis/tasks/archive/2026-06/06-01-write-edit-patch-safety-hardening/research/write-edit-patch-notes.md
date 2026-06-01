# Write/Edit/Patch Notes

## Current state

- `EditTool` already uses `FileSnapshotStore` and requires a recent `Read`
  before exact string edits.
- `ReadTool` records file snapshots into the same in-memory store when both
  tools are created by `default_tools`.
- Runtime file history snapshots are driven by `mutation_targets()` before
  mutation tools execute.
- `WriteTool` has `mutation_targets()` but lacks content safety, diff output,
  and stale overwrite controls.
- `ToolResultFormatter` can render a generic `diff` field, but does not yet
  specialize mutation summaries.

## Target shape

Keep exact-replace semantics for now, but make all mutation tools more
diagnosable:

- shared safety helpers for binary and secret-like checks
- stable error kinds
- bounded diffs
- Patch registered as a first-class built-in tool
- raw payloads that runtime trace/doctor can summarize without raw file content

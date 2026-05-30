# Node TUI Tool Lifecycle Rendering Research

## Existing mycli TUI

- `tui/node/src/state/reducer.ts` handles gateway notifications.
- `turn.event` with `phase="tool_call"` currently calls `applyToolEvent()` and
  appends a folded `tool_summary` row. This is model-side intent, not execution
  lifecycle.
- `ToolRow` already renders `ToolSummary` with semantic status:
  - `running` uses warning color
  - `failed` uses error color
  - otherwise accent
- `RunningActivity.activityPath()` derives a compact path from recent
  `tool_summary` rows, so adding live lifecycle rows will immediately improve
  the running line.
- `formatToolSummary()` already knows common tool names and status metadata, but
  it currently only understands `duration_ms`, not `duration_s` from the new
  runtime contract.

## Hermes Reference

- Hermes TUI receives `tool.start`, `tool.progress`, and `tool.complete` as
  separate channels.
- Active tools are shown while running, using spinner-like live rows.
- Completed tools are persisted into a tool trail; tests assert tool rows remain
  when `message.complete` arrives immediately after `tool.complete`.
- We should copy the semantic behavior, not code: live start, in-place complete,
  no duplication, persistence after final answer.

## Recommended mycli Shape

- Extend `state/transcript.ts` with `applyToolLifecycleEvent()`.
- Use transcript row metadata as the single state surface:
  - `tool_id`
  - `call_id`
  - `tool_name`
  - `status`: `running` / `done` / `failed`
  - `context`, `args_preview`, `summary`, `duration_s`, optional `error`
- `tool.start` should append a `tool_summary` if no matching row exists.
- `tool.complete` / `tool.failed` should update the latest matching row;
  fallback to append if no prior row exists.
- Update `formatToolSummary()` to derive:
  - target from `path`, `query`, `command`, `context`, `args_preview`, `summary`
  - detail from `duration_s` as seconds or milliseconds depending value
  - status from `success` and `status`

## Risks

- Existing model-side `tool_call` rows could duplicate execution-side rows. For
  this slice, matching by `tool_id`/`call_id` should coalesce when IDs are
  present; if model-side rows lack IDs they may remain separate. That is
  acceptable but tests should cover the new lifecycle path.
- Tool lifecycle events may arrive after assistant deltas. The reducer should
  append/update transcript rows without assuming they are the last item.
- Default view should not show raw error payloads or verbose args; keep details
  compact.

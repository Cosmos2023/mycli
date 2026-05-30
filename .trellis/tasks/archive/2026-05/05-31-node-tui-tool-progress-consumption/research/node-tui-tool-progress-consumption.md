# Node TUI Tool Progress Consumption Research

## Existing Behavior

- The runtime branch now emits `tool.progress` as a real execution lifecycle
  notification after `tool.start` and before `tool.complete` / `tool.failed`.
- `NodeTuiGateway` maps `tool_progress` to direct `tool.progress` and envelope
  mirror `runtime.event`.
- The Node TUI reducer currently handles `tool.start`, `tool.complete`, and
  `tool.failed` through `applyToolLifecycleEvent(...)`.
- `applyToolLifecycleEvent(...)` matches existing `tool_summary` rows by
  `tool_id` first and `call_id` second, then merges metadata in place.
- Running activity derives its compact tool trail from recent `tool_summary`
  rows, so updating the existing row is enough to make progress visible without
  a new component.

## Recommended Approach

- Extend `applyToolLifecycleEvent(...)` to accept `tool.progress`.
- Map `tool.progress` to the same visible row as `tool.start`, preserving
  `status: "running"` and merging progress metadata such as `stage` and
  `message`.
- If `tool.progress` arrives without a prior `tool.start`, append a compact
  running fallback row instead of dropping the event.
- Teach the reducer to route `tool.progress` through the same lifecycle helper.
- Keep rendering dense:
  - no extra transcript row for progress after a matched start
  - no new panel or layout changes
  - no raw payload display

## Risks

- Treating progress as a terminal status would make running tools appear done.
  - Mitigation: `tool.progress` keeps `status: "running"`.
- Appending every progress event would create noisy transcripts.
  - Mitigation: update the matching row in place using existing matching logic.
- Showing the progress `message` as the primary target could hide a useful
  context path.
  - Mitigation: keep existing lifecycle target priority (`context` before
    summary/message-like fields); store message in metadata for future display.

## Out Of Scope

- No Python runtime changes.
- No active tool shelf or new panel.
- No progress percentages.
- No extension/ACP consumers.

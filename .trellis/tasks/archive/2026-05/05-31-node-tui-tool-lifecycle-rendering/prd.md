# Node TUI Tool Lifecycle Rendering

## Goal

Make the Node TUI consume the runtime `tool.start`, `tool.complete`, and
`tool.failed` notifications added in the runtime contract slice, so users see
real tool execution progress while a turn is running instead of waiting for
final `turn.completed.activity_events`.

## Context

- Runtime P2 now emits execution-side lifecycle notifications from
  `ToolExecutionService` through `NodeTuiGateway`.
- Existing Node TUI already renders `tool_summary` transcript rows and derives
  the running activity path from recent tool rows.
- Hermes TUI keeps a live active tool trail and persists completed tool rows.
  mycli should match the semantic behavior while staying inside its current
  reducer/transcript architecture.

## Requirements

- Add Node TUI handling for gateway notification methods:
  - `tool.start`
  - `tool.complete`
  - `tool.failed`
- On `tool.start`, create or update a `tool_summary` transcript row for the
  current turn with running status.
- On `tool.complete`, update the matching `tool_summary` row in place to done
  status and include duration/summary metadata when present.
- On `tool.failed`, update the matching `tool_summary` row in place to failed
  status and include duration/summary/error metadata when present.
- Match tools by stable `tool_id` first, then `call_id` when present.
- Do not duplicate rows when complete/failed arrives for an already started
  tool.
- If a completion arrives without a prior start, create a compact summary row
  so the event is still visible.
- Preserve existing handling for:
  - model-side `turn.event` `phase="tool_call"`
  - `turn.completed`
  - `status.update`
  - approval rendering
- Keep the UI dense and professional:
  - use existing `ToolRow` rather than a new card/panel
  - running tools should use the existing running marker style
  - failed tools should visibly use failed status styling
  - no full raw result payloads in default view
- Keep this task TUI-side only; do not change runtime Python contracts unless a
  bug in the just-merged contract is discovered.

## Non-Goals

- Do not add `tool.progress` yet.
- Do not implement Hermes' full active tool shelf or collapsible tool panel.
- Do not migrate the gateway to a unified event envelope.
- Do not change Python tool execution behavior.
- Do not merge this branch into `main`.

## Acceptance Criteria

- Reducer tests prove `tool.start` creates a running tool row and
  `tool.complete` / `tool.failed` update that row without duplication.
- Transcript/ToolRow tests prove running, done, and failed lifecycle rows render
  with readable labels and details.
- Existing Node TUI tests continue to pass.
- Typecheck passes for `tui/node`.
- Trellis spec is updated if the TUI-side contract knowledge changes.
- Work is committed and archived on `feature/mycli-tui-polish` only.

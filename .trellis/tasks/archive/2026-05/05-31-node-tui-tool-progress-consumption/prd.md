# Node TUI Tool Progress Consumption

## Goal

Teach the Node TUI to consume the Hermes-like `tool.progress` event by updating
the existing running tool row in place, keeping the UI live without adding
transcript noise.

## Context

- Runtime now emits `tool.progress(stage="executing")` between `tool.start`
  and the terminal tool lifecycle event.
- Node TUI already consumes `tool.start`, `tool.complete`, and `tool.failed`
  into compact `tool_summary` rows.
- The next parity step is to make `tool.progress` a first-class consumed event
  while keeping the current dense transcript architecture.

## Research References

- [`research/node-tui-tool-progress-consumption.md`](research/node-tui-tool-progress-consumption.md)
  documents the reducer/transcript approach and risks.

## Requirements

- Update Node TUI state handling for direct `tool.progress` events.
- `tool.progress` must update the matching `tool_summary` row by `tool_id`
  first and `call_id` second.
- A matched `tool.progress` must not append a duplicate transcript row.
- `tool.progress` must keep the row status as `running`.
- Progress metadata (`stage`, `message`, `args_preview`, etc.) must be
  preserved on the row for rendering/future consumers.
- If `tool.progress` arrives before `tool.start`, create a compact running
  fallback `tool_summary` row.
- `runtime.event` wrapping `tool.progress` must reach the same reducer path
  through the existing envelope unwrap.
- Keep `tool.complete` and `tool.failed` terminal behavior unchanged.
- Do not change Python runtime/gateway behavior in this slice.
- Do not add a new visual panel, shelf, color theme, or layout change.
- Do not merge into `main`.

## Non-Goals

- Do not render raw progress payloads.
- Do not invent percent progress.
- Do not change `RunningActivity` layout.
- Do not implement extension/ACP consumption.

## Acceptance Criteria

- Transcript unit tests prove `tool.progress` updates a started row in place.
- Transcript/reducer tests prove progress-before-start creates a running
  fallback row.
- Reducer tests prove `runtime.event(type="tool.progress")` updates the same
  lifecycle row.
- Existing tool complete/failed tests still pass.
- Node typecheck and focused tests pass.
- Trellis task is archived and work is committed only on
  `feature/mycli-tui-tool-progress-consumption`.

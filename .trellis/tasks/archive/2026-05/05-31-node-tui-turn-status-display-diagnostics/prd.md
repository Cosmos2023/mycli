# Node TUI Turn Status Display Diagnostics

## Goal

Surface bounded `turn.status` detail in the Node TUI status line so failures
and interruption requests are easier to diagnose without adding new panels,
transcript rows, or layout churn.

## Context

- The reducer now consumes `turn.status` as status-only state.
- `turn.status` can carry a `message` field for failures and interruption
  requests.
- The status line currently shows `liveStatus.text` for non-completed states
  but drops any detail message.
- Hermes-like usability means terminal status should be visible and useful
  without forcing users to infer state from logs.

## Research References

- [`research/turn-status-display-diagnostics.md`](research/turn-status-display-diagnostics.md)
  documents the current status line and recommends bounded detail display.

## Requirements

- Extend `LiveStatus` with optional `message`.
- Preserve `message` from incoming `turn.status` / compatible status payloads.
- Update status metadata so non-completed live statuses render:
  - just `text` when no detail message exists
  - `text: detail` when a detail message exists
- Bound detail length so long runtime errors cannot dominate the footer/status
  line.
- Do not append transcript rows from this detail.
- Do not change RunningActivity rendering in this slice.
- Keep completed status hidden from the status line, matching existing behavior.

## Non-Goals

- Do not add a new diagnostics panel.
- Do not change colors, layout, theme tokens, or keybindings.
- Do not change Python gateway behavior.
- Do not change `turn.failed` transcript rendering.
- Do not merge into `main`.

## Acceptance Criteria

- Unit tests prove status metadata includes bounded `turn.status` detail.
- Unit tests prove long detail messages are truncated.
- Existing waiting approval and completed-status behavior remains unchanged.
- Node focused tests pass.
- Node type-check passes.
- Trellis task is archived and work is committed only on
  `feature/mycli-tui-turn-status-display`.

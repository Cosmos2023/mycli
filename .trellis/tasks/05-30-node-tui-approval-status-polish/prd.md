# Node TUI Approval Status Polish

## Goal

Make the Node TUI visibly benefit from the newly merged Hermes-like
`approval.request` and `status.update` contract. The UI should show explicit
approval gates and live turn state with clearer hierarchy, color semantics, and
test coverage.

## Context

- Runtime P1 is already merged into `main` and this worktree.
- Contract spec: `.trellis/spec/backend/runtime-tui-gateway-contract.md`.
- This TUI branch should not add new runtime protocol channels yet.
- Hermes reference direction: status updates are rendered as short live status
  text, and approval gates are treated as focused overlays/panels rather than
  vague transcript hints.

## Requirements

- Keep existing Ink/React architecture and current component names unless a
  very small helper improves clarity.
- Improve `ApprovalPrompt` so it is an actionable approval panel:
  - display a stable title and decision context
  - display optional `tool_name` and `reason` when available
  - display numbered choices with clear keyboard affordance
  - use theme tokens instead of hardcoded colors where possible
  - keep numeric key handling unchanged
- Improve live running/status display:
  - map `liveStatus.state` to semantic color and glyph/label
  - keep layout compact; do not add a full dashboard or extra card layer
  - retain recent tool activity path when available
  - avoid showing stale terminal states as active running rows
- Improve status metadata:
  - include concise live status text when meaningful
  - keep session/model/theme/context metadata intact
  - keep `approval pending` visible when a decision is pending
- Add tests for:
  - approval panel renders preview, reason, tool name, and numbered options
  - approval key handling still calls `onDecision(decision_id, choice)`
  - running activity renders state-aware status text/color markers
  - status metadata includes live status without dropping existing metadata

## Non-Goals

- Do not add `tool.start/tool.progress/tool.complete`.
- Do not add `message.delta/message.complete` or reasoning stream rendering.
- Do not migrate to Hermes' unified `method: "event"` envelope.
- Do not copy Hermes source code.
- Do not redesign the whole TUI layout.

## Acceptance Criteria

- Node TUI approval/status rendering consumes the existing `ShellState`
  `pendingApproval` and `liveStatus` fields.
- UI behavior remains keyboard-compatible with current tests.
- `npm run typecheck` passes.
- `npm test` passes for the Node TUI.
- The diff remains limited to TUI presentation/helpers/tests plus Trellis task
  artifacts.

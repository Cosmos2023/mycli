# Node TUI Approval/Status Polish Research

## Local mycli Findings

- `ApprovalPrompt` currently renders a rounded bordered box with a hardcoded
  yellow title, preview text, and numbered options.
- `ApprovalPrompt` already owns numeric keyboard handling through `useInput`.
  The behavior should stay unchanged.
- `RunningActivity` renders only while `state.turnRunning` is true. It now
  prefers `state.liveStatus?.text` over hardcoded `Thinking`, but all active
  states share the same warning color.
- `StatusLine.statusMetadata()` includes session id, model, theme, context
  usage, and `approval pending` when `pendingApproval` exists.
- Runtime P1 reducer already stores:
  - `ShellState.pendingApproval`
  - `ShellState.liveStatus`
  - terminal clearing behavior for completed/failed/interrupted states

## Hermes Reference Findings

- Hermes treats approvals as explicit overlays and sets short status text such
  as `approval needed` while the overlay is active.
- Hermes handles `status.update` as a live status channel, not as transcript
  content. Some status messages become transient notes, warnings, or process
  updates depending on `kind`.
- Hermes keeps status and approval separate from assistant text. This matches
  the target contract already documented for mycli.

## Design Implications For This Slice

- Keep mycli's existing single-column TUI anatomy. Do not introduce Hermes'
  larger overlay/store architecture yet.
- Use existing theme semantic tokens (`accent`, `muted`, `warning`, `success`,
  `error`) instead of adding new theme fields.
- Treat `waiting_approval` as warning/attention, `failed` and `interrupted` as
  error, `completed` as success, and `running` as accent/warning depending on
  context.
- Since `RunningActivity` only renders when `turnRunning` is true, terminal
  state display belongs mostly in `statusMetadata()`, while the running row
  should focus on active `running` and `waiting_approval` states.

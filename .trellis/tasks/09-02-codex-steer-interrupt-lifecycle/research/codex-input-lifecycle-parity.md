# Codex Input Lifecycle Parity Research

## Scope

Direct source comparison only. Baseline repository:
`/Users/cosmos/Downloads/codex-main`. No OpenAI documentation or skill material was used.

## Codex Behavior

### Pending steer ownership

- `codex-rs/tui/src/chatwidget/input_submission.rs:322` captures the complete pending steer,
  including text, local/remote images, text elements, mention bindings, history, and a compare key.
- `codex-rs/tui/src/chatwidget.rs:1328` matches the committed user display against that compare key
  and only then removes the pending steer and renders it into history.

Result: transport acceptance does not discard the recoverable local input.

### Esc while steering

- `codex-rs/tui/src/chatwidget/interaction.rs:135` detects Esc with pending steers while the task is
  running, latches `submit_pending_steers_after_interrupt`, and requests interrupt.
- Failure to submit the interrupt clears the latch; repeated normal input handling does not
  silently turn a successful intent back off.

### Interrupt terminal behavior

- `codex-rs/tui/src/chatwidget/input_restore.rs:145` finalizes the owning turn, records one notice,
  and consumes the immediate-resubmit latch once.
- When immediate resubmit is selected, pending steers are merged and submitted as one new user
  message. Otherwise pending, rejected, and queued messages are restored to the composer.
- `codex-rs/tui/src/chatwidget/input_restore.rs:200` rebases image placeholders and text element
  ranges while merging messages.

### Session switching and resume

- `codex-rs/tui/src/chatwidget/input_restore.rs:342` snapshots composer and pending input per
  thread.
- `codex-rs/tui/src/app/thread_routing.rs:1324` restores thread input state before replaying turns
  and events, then re-enables queue autosend and optionally submits the next queued input.

Result: input state belongs to the thread and restore ordering is explicit.

## Mycli Gaps

- Full durable identity exists in `backend/packages/core/src/queue-state.ts:16`, and the gateway
  publishes it in `backend/apps/mycli/src/node-runtime/node-gateway.ts:4226`.
- The TUI reduces durable records to a lossy preview at
  `tui/mycli-shell/src/adapters/runtime-state.ts:129` and concatenates local and durable records at
  `tui/mycli-shell/src/adapters/runtime-state.ts:525`.
- `tui/mycli-shell/src/adapters/runtime-state.ts:2156` removes all local forms of an input on ACK,
  before a committed user item is observed.
- `tui/mycli-shell/src/gateway.ts:571` keeps busy-turn follow-ups only in TUI memory despite the
  backend `turn.follow_up` RPC.
- `tui/mycli-shell/src/shell-runtime.ts:3384` omits `userTurnPendingStart` from running detection.
- TUI terminal reducers at `tui/mycli-shell/src/adapters/runtime-state.ts:1607`, `:1707`, and
  `:1741` can clear a newer active turn when a stale event arrives.
- Backend next-turn scheduling is conditional on successful completion at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2523`, `:2586`, and `:2653`.
- `backend/apps/mycli/src/node-runtime/node-gateway.ts:2678` removes a record after reservation but
  before the full active-turn setup is durable/recoverable.

## Mapping Decision

Copy Codex's observable semantics, not its internal storage structure:

- retain pending input until committed lifecycle or explicit restoration;
- make Esc with pending steer an explicit, one-shot interrupt-and-resubmit intent;
- restore complete composer state, including correctly rebased images;
- restore session input before queued autosend;
- add mycli-specific durability by making the backend queue authoritative and dispatch claims
  recoverable.

This approach avoids a second local dispatch queue while preserving the behavior users expect
from Codex.

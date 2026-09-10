# Turn Completion History Ownership

## Reproduction

After a completed turn already showed its stored duration, pressing Ctrl+C in an
empty composer appended an exit hint. The footer still said `Completed`, and the
renderer checked only whether the final transcript block was a duration item.
The hint moved that item away from the end, so the renderer appended a second,
locally calculated completion row. Mode-switch failures reproduced the same
problem; switching sessions could display the prior session's elapsed time.

Eight of ten new terminal regression cases failed before the fix. Both ordinary
and native rendering reproduced the issue without starting another turn.

## Implementation

The runtime renders completed durations exclusively from `turn_completed`
transcript blocks. The existing reducer upserts one item using the stable
`turnCompletedDurationId(turnId)` identity, and history loading restores that same
item. The rendering fallback and `completedDurationMs` cache have been removed.
The local running timer resets when activity stops and cannot create historical
duration rows.

Status-only updates, local notices, shortcuts, replay, and resize cannot add a
duration row. Missing duration or turn identity produces no new item; existing
authoritative zero durations remain valid. Interrupt and failure paths keep
their existing diagnostics and do not manufacture successful completion rows.

## Codex Comparison

The local `codex-main/codex-rs/tui/src/chatwidget/turn_runtime.rs` snapshot adds a
`FinalMessageSeparator` in `on_task_complete`, clears the turn's work/separator
flags, and avoids creating a new separator during replay. Displaying a history
cell does not finish a turn again. Mycli now follows this history-ownership
principle through its existing canonical transcript records.

This change retains Mycli's compact completion-row formatting and deterministic
phrase selection. Codex's separate rules for work-activity visibility, metrics,
and the duration-label threshold are not part of this duplicate-row fix. The
comparison uses a local source snapshot, not a verified latest release.

## Verification

The new tests inspect logical output and real terminal cells in both modes.
They cover Ctrl+C exit prompts and draft clearing, Esc, Ctrl+O, mode-switch
failure, full-transcript open/close, resize, missing duration, status-only
completion, duplicate terminal events, multiple turns, interruption, and session
history reload followed by a status refresh.

All ten new regression cases and the existing focused shell/runtime tests passed.
The full `npm test --ignore-scripts` run passed all 360 test files: 303 unit, 22
contract, 29 integration, 5 platform, and 1 release. It completed in 160.8 seconds.

`npm run build`, `npm run lint`, `npm run typecheck`, `npm run contracts:check`,
`npm run config:check`, and `git diff --check` also passed.

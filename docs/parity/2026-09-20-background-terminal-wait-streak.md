# Codex Wait-Streak Alignment For Background Terminal Polls

Reference: `codex-rs/tui/src/chatwidget/command_lifecycle.rs` and
`codex-rs/tui/src/history_cell/exec.rs` (source snapshot under
`native/windows-sandbox-helper/build/codex-source/`), inspected on 2026-09-20.

## Problem

Every `WriteStdin` poll arrived as its own `tool.start`/`tool.complete` pair, so the TUI appended
one `Waiting for background terminal` / `Waited for background terminal` row per poll. A single
wait for a slow process printed a column of near-identical rows.

## Codex behavior

`ChatWidget::on_terminal_interaction` treats an empty stdin interaction as a *wait*, not as a
transcript item:

- the wait is surfaced in the status indicator only (`Waiting for background terminal`, with the
  command as details and the interrupt hint kept visible);
- consecutive polls for the same process refresh one `unified_exec_wait_streak`;
- the streak is flushed as one `history_cell::new_unified_exec_interaction(.., String::new())`
  cell (`• Waited for background terminal`) when a non-empty stdin arrives for that process, when
  the process completes, when the turn ends, or before assistant text is streamed;
- a poll for a process that is no longer tracked shows nothing at all.

## mycli implementation

`RuntimeShellState.terminalWaitStreak` mirrors that streak. A poll tool event no longer writes a
transcript row: it refreshes the wait status line through `extendTerminalWait`, and the wait is
written once by `flushTerminalWait` when it ends (input to the same shell, shell completion or
removal, turn completion/failure/interrupt, terminal status snapshots, assistant or plan text, or
the next shell being polled). Polls for a shell that already reached a terminal state are ignored,
matching Codex's untracked-process case. Resumed transcripts collapse a run of poll records into
the same single row, so history and live rendering agree.

## Verification

- `tui/mycli-shell/test/components/transcript/terminal-interaction.test.ts`: repeated polls keep
  one status line and exactly one wait row, replayed completions cannot duplicate the row, failed
  polls settle with a visible failure row, and headless terminal frames stay free of stale rows.
- `tui/mycli-shell/test/state/runtime-state.test.ts`: three polls produce one wait row, and a
  resumed transcript collapses a run of polls.
- `backend/apps/mycli/test/terminal-interaction.platform.test.ts`: a real PTY turn with a poll,
  two inputs, and a final poll produces `poll, input, input` rows live; the resumed transcript
  keeps the collapsed wait rows.

Unit suite (374 files), TUI suite (953 tests), lint, workspace type checking, contract drift
check, and build all pass. One unrelated `node-backend` image-attachment test timed out under
full-suite load and passes in isolation.

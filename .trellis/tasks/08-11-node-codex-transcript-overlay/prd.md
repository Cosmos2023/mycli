# Codex-style Transcript Overlay

## Goal

Add a dedicated full-session transcript viewer to the Node/TypeScript mycli TUI so compact tool rows remain readable in the main conversation while users can inspect complete command output without losing terminal scrollback or polluting the model context.

## Requirements

- Bind `Ctrl+T` to an independent, full-screen transcript viewer.
- Keep `Ctrl+O` as the existing main-view tool detail toggle.
- Enter the terminal alternate screen while the viewer is open and restore the previous terminal state on every close path.
- Render the canonical committed session transcript plus the current turn's live tail.
- Support `Esc` and `q` to close, arrows and `j`/`k` to move, PageUp/PageDown to page, and Home/End plus `g`/`G` to jump.
- Reflow content on terminal resize and preserve the user's reading position unless they were following the live tail.
- Persist complete Shell command output separately from the bounded normal session snapshot.
- Load complete Shell output only when the transcript viewer needs it; it must not enter model input or normal session bootstrap payloads.
- Preserve append-only session history and resume behavior.
- Continue showing concise head/tail Shell output in the main conversation with a real `ctrl+t to view transcript` hint when content is omitted.
- For older sessions without full-output records, show the bounded stored output and an explicit unavailable-history notice.
- Keep the Python implementation unchanged.

## Acceptance Criteria

- [x] `Ctrl+T` opens a full-screen alternate-screen viewer without altering the main inline TUI scrollback.
- [x] Closing with `Esc` or `q` restores raw mode, cursor state, screen contents, and main input focus.
- [x] The viewer displays all committed transcript entries in canonical order and includes the active turn's live entries.
- [x] Long Shell results show complete persisted output in the viewer while the main view remains compact.
- [x] Full Shell output is fetched on demand and is absent from model-input assembly and ordinary bootstrap snapshots.
- [x] Viewer scrolling, resize reflow, follow-tail behavior, and narrow terminal rendering are covered by tests.
- [x] Old sessions degrade predictably when complete Shell output was never persisted.
- [x] Storage, gateway, TUI, type-check, lint, and PTY smoke checks pass.

## Definition of Done

- Core storage and viewport logic have focused unit tests.
- Gateway and resume paths have integration coverage.
- TUI key routing, lifecycle, scrolling, resize, live-tail, and restoration are verified.
- User-facing key hints and relevant runtime/TUI contracts are updated.
- Workspace tests, type-check, lint, and PTY smoke pass.

## Technical Approach

Use two projections over the same canonical command result. The normal conversation keeps the existing bounded head/tail projection. A dedicated alternate-screen viewer virtualizes the visible transcript rows and resolves complete Shell output through a paginated/on-demand gateway operation.

Store complete Shell output as append-only chunks keyed by session, shell execution, and sequence. Keep the existing bounded `shell_session` snapshot for fast resume and compatibility. The viewer first renders canonical transcript records, replaces bounded Shell output with complete chunks when available, and otherwise renders an explicit legacy fallback marker.

The overlay owns keyboard input while active. It caches wrapped rows by terminal width and transcript revision, tracks whether the user is following the tail, and redraws only on input, resize, or transcript changes.

## Decision (ADR-lite)

**Context**: Main-view tool output must stay compact, but developers need complete diagnostic output. Adding full output to ordinary session bootstrap or model history would increase latency and token usage.

**Decision**: Add an alternate-screen transcript viewer backed by separate append-only Shell output chunks and an on-demand gateway API. Retain the bounded Shell snapshot as the normal projection.

**Consequences**: New executions provide complete history without increasing model context. Storage grows with command output and therefore needs bounded page reads and future retention controls. Sessions created before this feature cannot recover output that was already discarded.

## Out of Scope

- Replacing the existing TUI renderer or component framework.
- Changing `Ctrl+O` semantics.
- Retroactively reconstructing output missing from old sessions.
- Adding transcript search, export, selection, or mouse interaction in this task.
- Modifying or removing the Python mycli implementation.

## Technical Notes

- Codex references are recorded in `research/codex-transcript-projection.md`.
- Existing bounded Shell storage: `backend/packages/storage/src/shell-transcript-store.ts`.
- Existing transcript RPC: `backend/apps/mycli/src/node-runtime/node-gateway.ts`.
- Existing canonical TUI transcript: `tui/mycli-shell/src/adapters/runtime-state.ts`.
- Existing overlay stack: `tui/mycli-shell/src/tui-core/tui.ts`.

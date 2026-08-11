# Codex Transcript Projection Reference

## Sources

- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/exec_cell/render.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/pager_overlay.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/app_backtrack.rs`

The local Codex source is the reference used for this design. The Codex manual helper returned HTTP 403, so no behavior is inferred from unavailable documentation.

## Observed Pattern

Codex keeps one canonical execution result and renders two projections:

- The inline conversation uses a compact command label, selected output head/tail rows, and an omission hint that points to `Ctrl+T`.
- The transcript overlay renders the command, complete formatted output, exit status, and duration.

The transcript overlay enters the alternate screen and composes committed history with a cached live tail. Its cache is keyed by width and content revision so resize causes reflow while stable history is not rebuilt on every streaming event.

## Mapping to mycli

- Preserve mycli's existing compact Shell component for the inline projection.
- Treat `RuntimeShellState.transcript` as the canonical ordering source.
- Persist complete Shell output outside the bounded normal session snapshot.
- Resolve complete output lazily when opening or advancing the transcript viewer.
- Virtualize visible lines and preserve follow-tail versus manual-scroll state.
- Restore the inline terminal surface on all close, interrupt, and error paths.

## Compatibility Notes

Old mycli sessions only contain bounded Shell output. The viewer must surface that limitation rather than imply the displayed output is complete. Full-output storage must not be added to provider/model input assembly or eager resume payloads.

# Codex Terminal Interaction Alignment

Reference: `/Users/cosmos/Downloads/codex-main`, inspected on 2026-09-09.

Codex's `codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs` emits an interaction
after non-empty input, including input that ends the process. Empty input emits a history event
only when the process remains alive. `codex-rs/tui/src/history_cell/exec.rs` renders the separate
`Interacted with background terminal` and `Waited for background terminal` rows.

mycli now follows those display rules through its existing `WriteStdin` tool. A typed optional
`terminal_interaction` field carries shell identity, bounded input/command previews, interaction
success, and whether the process remains alive. Live pending input and polling have distinct
states. The original Shell block owns output and exit status; sending Ctrl+C successfully does
not become a failed interaction simply because the process exits unsuccessfully.

The field passes through the Worker, tool lifecycle, gateway, canonical/legacy result storage,
readable projection, and TUI reducer. Concurrent polls are tracked by call ID. Completed
interaction records survive restart. Legacy raw stdin is not reconstructed for display.
Input previews are quoted, credential-redacted, and bounded; control input such as Ctrl+C and
Ctrl+D is shown visibly. This follows mycli's existing display privacy boundary rather than
copying Codex's raw stdin event payload.

Verification covers contract projection, adapter results, interrupted runtime events, both storage
paths, gateway projection, and reducer ownership. A real PTY in raw mode verifies input without
echo, a live poll, process completion, and backend restart. Headless terminal frames cover both
scrollback modes and resizing between 40, 80, and 120 columns without duplicate or stale rows.

All 1,228 related regression tests pass, including the complete TUI test directory. Build, lint,
workspace type checking, contract/config drift checks, and `git diff --check` pass. This validation
does not claim a clean full release suite; the earlier M6/M7 and packed startup-loading failures
recorded in [the image/resource report](2026-09-09-image-resource-tools.md) were not rerun here.

# Terminal And Accessibility

mycli resolves terminal capabilities once when an interactive session starts. The resulting color,
glyph, motion, and cursor choices are sent through the gateway with the effective settings, so TUI
components do not independently guess terminal behavior.

## Appearance Settings

The following user settings can be changed with `mycli config set`, or from `/settings` under
Appearance and accessibility:

| Setting | Values | Behavior |
| --- | --- | --- |
| `tui.color_mode` | `auto`, `truecolor`, `256`, `16`, `none` | Selects the highest allowed color depth; `NO_COLOR` and `TERM=dumb` still force no-color output |
| `tui.glyph_mode` | `auto`, `unicode`, `ascii` | Replaces interface chrome, tables, progress, and status glyphs with an ASCII-only set when required |
| `tui.reduced_motion` | `true`, `false` | Uses a static progress indicator instead of animated frames |
| `tui.high_contrast` | `true`, `false` | Uses stronger semantic status and selection tokens; labels and symbols still carry meaning without color |
| `tui.terminal_progress` | `true`, `false` | Shows or hides compact in-turn progress independently of reduced motion |
| `tui.hardware_cursor` | `true`, `false` | Places the real terminal cursor at the editor insertion point for CJK IME candidate windows |
| `tui.clear_on_shrink` | `true`, `false` | Clears stale cells when rendered content becomes shorter |

Examples:

```bash
mycli config set tui.color_mode none
mycli config set tui.glyph_mode ascii
mycli config set tui.reduced_motion true
mycli config set tui.hardware_cursor true
```

Use `mycli config unset <key>` to return a scalar setting to layered defaults. The complete
generated key and alias list is in [reference/configuration.md](reference/configuration.md).

## Custom Keymaps

Keymaps are structured TOML tables with separate `app`, `editor`, and `selector` contexts. A value
may be one key string, an array of alternatives, or an empty array for an optional unbound action.

```toml
[tui.keymap.app]
help = "ctrl+h"
command_palette = ["ctrl+p", "f2"]

[tui.keymap.editor]
cursor_word_left = ["alt+left", "alt+b"]

[tui.keymap.selector]
cancel = ["escape", "ctrl+c"]
```

mycli normalizes modifier order and rejects unknown actions, invalid key specifications,
same-context conflicts, and complete unbinding of required submit, confirm, cancel, interrupt, or
exit actions. A rejected layer leaves the previous effective keymap unchanged. `/settings` lists
the searchable effective action, binding, and winning source. Select `Reset keymap` there to remove
only the user keymap table and restore layered defaults; unrelated settings remain unchanged.

## Input And Resize Behavior

- CJK and emoji use terminal cell width rather than JavaScript string length for wrapping and
  truncation.
- Bracketed paste is buffered until its closing marker, including when input arrives in multiple
  chunks. Large pastes remain atomic editor markers and expand to their original content on submit.
- Every selector is keyboard reachable. `Esc` cancels or moves back one level without discarding
  the composer draft unless the active operation defines interrupt behavior.
- Resize events rebuild from transcript source. Widths 60, 80, 100, and 140 columns are regression
  tested, as are rapid shrink/grow bursts and stale wide-character cleanup.
- Emoji, Nerd Fonts, mouse input, and truecolor are optional. `TERM=dumb` selects no-color and ASCII
  fallbacks automatically.

## Shell And Automation Behavior

Read, legacy search/list tools, and recognized Shell searches share an `Exploring`/`Explored`
summary, including single operations. Consecutive reads combine deduplicated filenames in one
`Read` row. Searches show `Search <keywords> in <paths>`; file discovery shows `List <path>`.
Action labels use the accent color; targets use ordinary text. Rows wrap with hanging indentation
without a fixed target limit. Assistant messages, ordinary commands, mutations, and turn boundaries
end the group. Failed and cancelled operations retain explicit status markers, including failed
reads followed by a successful retry.

Simple POSIX `rg`, `grep`, and `rg --files` calls are recognized using `shell-quote` plus Node's
argument parser. Parsing is display-only. Unsupported options, pipelines, redirection, expansion,
and non-POSIX shells retain the original command display. Read ranges, empty/unchanged read
summaries, search filters, and results remain in the expanded tool view and `Ctrl+T` transcript.
Shell details retain the original command and output. Exit code 1 with no retained or omitted
output is not marked as a failed search; details show `No results` (or `No files found`) and the
original exit code. Diagnostics, interrupted commands, and timeouts remain explicit failures.

Shell approvals show the command in a syntax-colored preview with a subtle background and one
optional `Reason` line. The model's sanitized `justification` takes precedence; when absent, the
line uses the runtime's policy explanation. If neither is available, the line is omitted. There is
no separate `Approval` line and no extra model request to fill in a reason. The same selection
applies when restoring previously saved approvals.
The model supplies `justification` as an approval question when requesting `require_escalated`,
and omits it for ordinary Shell calls. The model-visible Shell schema omits `description`;
older calls carrying that field remain executable and retain their original records.
Reasons are bounded, credential-redacted,
and safe for terminal display, including after session resume. Risk and persistent allowance rules
have separate labels; the selected decision has a full-row
highlight. Color-free terminals retain the command, selection marker, and numeric choices. Long
commands remain available in the full-text inspection view, and terminal resizing keeps the
command and selected decision visible. Approval choices and keyboard bindings are unchanged.

`Shell` and `WriteStdin` return an estimated 500 tokens by default. `max_output_tokens` can
request more output, up to 2,000 estimated tokens (the shared 8,000-character result limit),
or a lower runtime-configured maximum. Truncation retains both the beginning and end of the
output. Legacy Shell calls without an explicit budget keep the same default.

Background terminal input shows `Interacting with background terminal`, then
`Interacted with background terminal`, with the original command and a bounded, redacted input
preview. Whitespace and control input are visible, including `^C` and `^D`. Empty `WriteStdin`
calls show `Waiting for background terminal`; `Waited for background terminal` remains in the
transcript only if the process was still running when the poll returned. A poll that observes
process completion leaves no extra waiting row. Output continues updating the original Shell
block. Successfully sending Ctrl+C remains an interaction even if the process exits unsuccessfully;
failed writes and interrupted calls have explicit error states. Completed interaction records
survive session resume. Older records without explicit safe previews keep their input hidden.

Interactive chat requires terminal stdin and stdout. Without both, mycli exits with one concise
`tty_required` diagnostic and does not start the backend or TUI. Provider-free commands such as
`config`, `doctor`, `session`, and `completion` remain ordinary stdout commands in pipes and CI.
They do not emit full-screen control sequences or progress animation.

Generate shell completion without starting a provider or interactive runtime:

```bash
mycli completion bash
mycli completion zsh
mycli completion fish
mycli completion powershell
```

See [commands.md](commands.md#shell-completion) for shell-specific loading commands.

## Compatibility Checklist

When terminal output is degraded, check these in order:

1. Run `mycli config get tui.color_mode` and `mycli config get tui.glyph_mode`.
2. Check `NO_COLOR`, `TERM`, `COLORTERM`, and the locale (`LANG` or `LC_ALL`).
3. Use `tui.glyph_mode = "ascii"` for older consoles, serial terminals, or restricted SSH paths.
4. Use `tui.hardware_cursor = true` when an IME candidate window appears away from the editor.
5. Run `mycli doctor` for bounded terminal and sandbox diagnostics; raw environment values and
   credentials are not included in its output.

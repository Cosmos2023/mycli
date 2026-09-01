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

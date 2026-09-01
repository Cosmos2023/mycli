# Terminal Accessibility Gap Audit

## Scope

This audit compares the current Node/TypeScript mycli terminal surface with the local Codex source
at `/Users/cosmos/Downloads/codex-main`. It covers configurable keymaps, terminal capabilities,
accessibility preferences, shell completion, and non-TTY behavior.

## Current Mycli Surface

### Keybindings

- `tui/mycli-shell/src/tui-core/keybindings.ts` owns default editor and selector actions.
- `tui/mycli-shell/src/keybindings.ts` adds application actions and installs one global
  `KeybindingsManager`.
- The manager already normalizes duplicate bindings, resolves defaults versus user overrides,
  reports conflicts within a context, and exposes the effective bindings.
- Keybindings are not represented in config, gateway payloads, settings state, or durable user
  preferences.
- Several visible hints are selected through hard-coded action switches, so a future custom binding
  would execute correctly only after runtime wiring but could still render the default key.

### Appearance And Terminal Capability

- `backend/packages/config/src/shell-setting-catalog.ts` owns nine scalar visual descriptors with
  layered provenance and single-setting persistence.
- `tui/mycli-shell/src/theme/theme.ts` selects color enablement and depth at module load from
  `NO_COLOR`, `COLORTERM`, and `TERM`.
- The current theme supports truecolor, 256-color, and 16-color conversion internally, but it has no
  runtime semantic `auto|truecolor|256|16|none` preference.
- Reduced motion, glyph fallback, and high contrast are not first-class settings. Progress visibility
  exists as `tui.terminal_progress`, but animation and visibility are not separate decisions.
- Terminal capability checks are scattered and can be reevaluated by individual components instead
  of being resolved once at startup.

### Gateway And TUI Settings

- `settings.load` and `settings.save` project scalar shell settings plus sources and the settings
  catalog.
- The TUI depends on gateway DTOs rather than importing backend config implementation, which is the
  correct ownership boundary to preserve.
- The settings selector is already searchable and supports nested actions. It can host an effective
  keymap viewer without introducing another top-level interaction system.
- No RPC currently resets keymaps or projects terminal capability/degradation metadata.

### CLI And Non-TTY

- Provider-free management dispatch happens before TTY validation.
- Interactive chat exits with one concise `tty_required` diagnostic when stdin or stdout is not a
  TTY.
- Root help text, management command recognition, and parsing currently have multiple manually
  maintained surfaces.
- There is no `mycli completion <bash|zsh|fish|powershell>` command. Adding shell-specific command
  lists would create a fourth drift-prone surface.

## Codex Reference

- `codex-rs/config/src/tui_keymap.rs` defines typed context tables, normalized key specs, unknown
  action rejection, and empty arrays for explicit unbinding.
- `codex-rs/tui/src/keymap.rs` owns runtime precedence, reserved/required action checks, conflict
  validation, and effective keymap presentation.
- `codex-rs/cli/src/main.rs` generates completion for bash, zsh, fish, and PowerShell from the same
  command tree used by parsing and help.
- `codex-rs/tui/src/tui.rs` validates terminal ownership before interactive startup and caches
  terminal capabilities.
- `codex-rs/tui/src/terminal_palette.rs` grades truecolor, 256-color, and 16-color support and applies
  bounded terminal-specific upgrades.

## Decisions

1. Put the canonical keymap action catalog in `@mycli/contracts`. It contains stable action id,
   context, config key, description, default keys, and required/cancelable metadata. Both config and
   TUI may depend on it without reversing the TUI/backend dependency direction.
2. Parse `[tui.keymap.app]`, `[tui.keymap.editor]`, and `[tui.keymap.selector]` as structured layered
   config. Reject unknown actions, invalid key specs, required-action unbinding, and context-local
   conflicts before replacing the effective keymap.
3. Keep structured keymap state separate from scalar `ShellSettings`. Extend `LoadedShellSettings`
   with a dedicated keymap projection rather than weakening scalar descriptor types.
4. Project effective keybindings through `settings.load`; add an explicit keymap reset RPC. Install
   the projected bindings in the TUI and derive visible hints from the same manager.
5. Add scalar descriptors for `tui.color_mode`, `tui.reduced_motion`, `tui.glyph_mode`, and
   `tui.high_contrast`. Keep `tui.terminal_progress` as the visibility switch; reduced motion makes
   an enabled progress row static.
6. Resolve terminal capabilities once from explicit settings plus startup environment. Pass a
   bounded DTO to the TUI; do not let components independently inspect process environment.
7. Introduce one canonical management CLI metadata registry. Parsing, root help, command-name
   recognition, and completion generation must consume it directly or be tied to it by drift tests.
8. Preserve the existing provider-free ordering: completion and other management commands run on
   ordinary stdout before backend/provider/TUI startup, while non-TTY interactive chat keeps its
   concise failure.

## Implementation Batches

1. Contracts/config: canonical keymap catalog, key parsing/validation, layered provenance, reset
   persistence, appearance descriptors, and generated config reference.
2. Gateway/TUI: settings DTO projection, one-time terminal capability snapshot, effective keymap
   installation, live key hints, searchable viewer/reset, and semantic theme/glyph/motion mapping.
3. CLI: canonical command metadata, four completion renderers, provider-free dispatch, help/parser
   drift tests, and explicit non-TTY regressions.
4. Regression/docs: no-color/ASCII/reduced-motion output, conflicts and rollback, CJK/IME/paste,
   selector Esc, resize/shrink, 60/80/100/140 widths, generated docs, build, and package smoke.

## Risks

- Moving every command parser to a new registry in one change would create unnecessary regression
  risk. The first completion version should extract shared metadata and add strong drift tests while
  preserving specialized parsing functions.
- A key action can be valid syntactically but unusable in a legacy terminal. Required cancel and
  submit actions need conservative defaults and validation against complete unbinding.
- Global mutable theme/keybinding singletons can leak between tests or resumed runtimes. Runtime
  application methods must be deterministic and tests must restore or explicitly set state.
- No-color mode must disable all styling escape sequences, not only foreground colors.


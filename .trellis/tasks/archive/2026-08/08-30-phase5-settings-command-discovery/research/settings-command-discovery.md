# Settings And Command Discovery Research

## Current mycli boundary

- `node-slash-command-registry.ts` is already the canonical parser and routing source, but
  `command.list` returns only rows marked `visible`. The TUI therefore cannot explicitly search
  hidden-but-supported commands, aliases, capability requirements, or unavailable reasons.
- `CommandPaletteComponent` fuzzy-matches only canonical name, argument hint, and description. It
  hides no aliases deliberately because aliases are absent from the payload, and it can explain
  only the active-turn restriction.
- `/settings` is a visual-only selector backed by one lossless user-config writer. It has no
  categories, descriptor payload, per-row source, lock state, navigation to dedicated selectors,
  or permanent-write preview.
- Model, credential, permission, trust, session, integration, and diagnostic flows already have
  dedicated commands/components. Reimplementing their mutation logic inside a generic settings
  editor would duplicate validation and approval boundaries.

## Codex patterns

- `codex-rs/tui/src/slash_command.rs` owns canonical command names, descriptions, task-time
  availability, platform visibility, and presentation order.
- `codex-rs/tui/src/bottom_pane/command_popup.rs` derives its rows from that registry, suppresses
  redundant aliases in the default list, and uses runtime capability flags to determine the
  available command set.
- Codex keeps model, permissions, theme, statusline, keymap, memories, MCP, plugins, and other
  settings in focused selectors. The command surface is the discoverable index; domain selectors
  remain responsible for validation and persistence.
- Config changes are typed domain edits. Interactive components do not receive arbitrary TOML
  paths or credential values.

## Feasible approaches

### A. Gateway catalog plus focused domain selectors (recommended)

Return a bounded settings catalog from `settings.load`, composed from canonical shell-setting
descriptors and current runtime projections. The TUI renders a categorized searchable index.
Visual settings use a value/scope preview; action rows open the existing model, login, permission,
trust, session, resource, and diagnostic flows through a selector stack. Extend command discovery
metadata from the slash registry and show search-only or unavailable commands only after an
explicit query.

Pros: one source for labels/values, no duplicated domain mutations, actionable unavailable states,
and small extensions to existing gateway/TUI boundaries. Cons: requires a versioned descriptor
payload and cross-layer tests.

### B. Assemble everything inside the TUI

Infer categories and values from current shell state and hard-code actions in
`settings-selector.ts`.

Pros: smaller backend diff. Cons: labels, aliases, availability, allowed values, and sources drift
from config/gateway behavior; native and future clients cannot reuse it.

### C. Generic config editor

Expose arbitrary config paths and edit all settings through a universal form.

Pros: superficially broad coverage. Cons: bypasses typed model/auth/permission workflows, widens
the mutation surface, complicates secrets and managed locks, and does not match Codex ownership.

## Selected boundary

Use approach A. The settings center is a navigation and safe-choice surface, not a second policy
or config engine. Keep credentials masked, managed permission rows locked, restart requirements
explicit, and unsupported update/setup actions visible only on direct search with a bounded reason.
Permanent visual writes require a preview and explicit user-default choice; session-only changes
apply immediately without rewriting user config.

## Relevant files

- `backend/packages/config/src/shell-settings.ts`
- `backend/packages/config/src/runtime-setting-catalog.ts`
- `backend/apps/mycli/src/node-runtime/node-slash-command-registry.ts`
- `backend/apps/mycli/src/node-runtime/node-gateway.ts`
- `tui/mycli-shell/src/components/settings-selector.ts`
- `tui/mycli-shell/src/components/command-palette.ts`
- `tui/mycli-shell/src/components/help-overlay.ts`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/slash_command.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/bottom_pane/command_popup.rs`

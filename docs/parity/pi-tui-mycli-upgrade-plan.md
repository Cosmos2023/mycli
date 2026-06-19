# pi-tui Based mycli TUI Upgrade Plan

This plan turns the pi-agent / pi-tui TUI review into an implementation sequence
for mycli. It is intentionally scoped as a product and architecture plan, not a
request to copy pi-agent's runtime.

Related references:

- `docs/parity/pi-agent-tui-lessons.md`
- `docs/parity/tui-experience-blueprint.md`
- `docs/parity/tui-development-roadmap.md`
- `tui/mycli-shell/src/tui-core/`
- `tui/mycli-shell/src/components/`
- local reference source: `pi-tui/src/`
- local reference source: `coding-agent/src/modes/interactive/components/`

## Intent

Use pi-tui as mycli's terminal component foundation and selectively adapt
pi-agent's higher-level interaction components so mycli feels like a complete
local coding-agent workbench:

```text
session aware -> searchable history -> visible tools -> safe approvals
-> inspectable changes -> configurable UI -> recoverable long sessions
```

The desired end state is not visual parity with pi-agent. The desired end state
is a stable mycli-owned TUI architecture:

```text
Python runtime
  owns models, tools, approvals, hooks, plugins, memory, sessions, traces

JSON-RPC gateway
  owns typed state/event projection between Python and Node

mycli-shell
  owns terminal lifecycle, keyboard routing, overlays, selectors, transcript UI

pi-tui-derived tui-core
  owns rendering, input primitives, focus, overlays, markdown, lists, editors
```

## Current Findings

The low-level pi-tui layer is already mostly present in
`tui/mycli-shell/src/tui-core/`.

Only a small set of core files currently differ from `pi-tui/src/`:

- `autocomplete.ts` - mycli-specific slash label display.
- `components/editor.ts` - mycli-specific dropped-file paste normalization to
  `@path` references.
- `keys.ts` - mycli-specific key release handling changes.
- `terminal.ts` - mycli env names and native scrollback support.
- `tui.ts` - mycli env names, native scrollback behavior, and mycli log paths.

That means the main experience gap is not missing pi-tui primitives. The gap is
that mycli has not yet adapted enough of pi-agent's higher-level agent UI
components:

- rich session selector
- conversation tree selector
- settings/resource selectors
- tool renderer registry
- richer bash/tool status components
- theme/resource management

## Non-Goals

- Do not restore a long-lived `imported-ui/` copied source pool.
- Do not import pi-agent runtime packages into mycli-shell production code.
- Do not replace Python runtime ownership with TypeScript-side behavior.
- Do not make UI-only trust, approval, or tool policy decisions.
- Do not rewrite all selectors at once.
- Do not add dependencies unless a phase proves that existing pi-tui/mycli
  primitives cannot support the behavior.

## Architecture Rules

1. `tui-core/` may remain a mycli-adapted pi-tui fork.
2. `components/` must be mycli-owned presentation components.
3. Every adapted pi-agent component must receive mycli model types, not pi-agent
   runtime objects.
4. New Python fields must be projected through the gateway contract before the
   UI depends on them.
5. Components may own local UI state such as selected index, search query,
   folded rows, and overlay focus.
6. Components must not own durable runtime state such as session rename, tool
   approval, hook enablement, or plugin configuration.
7. Any resource mutation must route through runtime-backed commands or RPCs.

## Data Flow Target

```text
Runtime event / request result
  -> gateway typed payload
  -> MycliShellState
  -> transcript block or overlay model
  -> pi-tui component
```

For every phase, the implementation should define the state shape first, then
the component, then the keyboard actions, then the tests.

## Phase 1 - Session Selector Upgrade

Priority: highest.

Reason: session navigation is visible every day, currently too thin, and has
low implementation risk compared with conversation tree navigation.

Reference components:

- `coding-agent/src/modes/interactive/components/session-selector.ts`
- `coding-agent/src/modes/interactive/components/session-selector-search.ts`

Target capabilities:

- Display session title as the primary label, with id only as secondary detail.
- Toggle current workspace vs all sessions.
- Sort by recent, threaded, and relevance.
- Filter all sessions vs named sessions.
- Search with fuzzy tokens.
- Search with quoted phrase tokens.
- Search with `re:<pattern>` regular expressions.
- Toggle cwd/path visibility.
- Show empty-state guidance that tells the user what action changes the result.
- Preserve keyboard navigation with arrows, `j/k`, Enter, Esc, and Tab.

Deferred within this phase:

- Rename session.
- Delete session.
- Thread tree display if backend parent metadata is not yet available.

Runtime and gateway needs:

- Extend `MycliShellSession` with enough optional fields to support richer UI:
  `id`, `title`, `cwd`, `modified`, `created`, `messageCount`,
  `firstMessage`, `allMessagesText`, `parentSessionId` or `parentSessionPath`,
  and `named`.
- Keep old payloads valid by making new fields optional.
- Add tests around `/session`, `/session list`, and TUI state projection.

Acceptance markers:

- `/session` and the session picker no longer present raw session id as the
  main user-facing label when a title exists.
- Search results are stable and deterministic.
- Regex parse errors produce an empty/error state, not a crash.
- Keyboard navigation wraps safely.
- A 100+ session list remains readable and bounded.

Suggested tests:

- TypeScript unit tests for `parseSearchQuery`, `matchSession`, and selector
  navigation.
- Python gateway tests for session title and optional metadata projection.
- Integration test that `/session` display prefers title over id.

## Phase 2 - Conversation Tree Navigator

Priority: high after Phase 1.

Reason: long sessions and forks need a navigation surface. pi-agent's tree
selector solves a real product problem that transcript scrolling cannot solve.

Reference component:

- `coding-agent/src/modes/interactive/components/tree-selector.ts`

Target capabilities:

- Show conversation/session branch tree.
- Highlight active path.
- Navigate with arrows and `j/k`.
- Fold and unfold branches.
- Page through long trees.
- Filter by default, no-tools, user-only, labeled-only, and all.
- Search visible tree entries.
- Jump to a selected turn/message.

Deferred within this phase:

- Editing labels from the TUI.
- Label timestamp display.
- Deep tool-call formatting for every tool type.

Runtime and gateway needs:

- Define a mycli conversation tree payload independent of pi-agent
  `SessionTreeNode`.
- Include message/tool role, id, parent id, summary text, timestamp, and label
  when available.
- Add a TUI command entry such as `/session tree` or a command palette action.

Current implementation notes:

- The gateway exposes a read-only `session.tree` RPC.
- The payload is a flat node list with `id`, `kind`, `session_id`, `parent_id`,
  `depth`, `role`, `summary`, `timestamp`, `label`, `message_index`,
  `tool_name`, active-path flags, message counts, and bounded preview text.
- The Node TUI owns the `SessionTreeSelectorComponent` interaction state:
  search, filter mode, selected index, fold/collapse state, and bounded preview.
- `/session tree` opens the local overlay and does not mutate runtime state.
- Selecting a node now attempts to jump the transcript viewport to a matching
  anchor. The UI first uses `anchor_id` when the backend has a stable history
  id, then falls back to the message index within the visible transcript.
  Selecting a node still emits a bounded notice/callback so no runtime mutation
  is required.

Acceptance markers:

- Forked or branched sessions can be inspected without reading raw session
  files.
- Long conversations can be filtered to user messages or non-tool content.
- Selecting a node moves the visible transcript anchor or opens a bounded
  preview.

## Phase 3 - Settings Selector Upgrade

Priority: medium-high.

Reason: many TUI behaviors already exist as state or env flags but are not
discoverable or persistent from the UI.

Reference component:

- `coding-agent/src/modes/interactive/components/settings-selector.ts`

Target capabilities:

- View mode: `default`, `verbose`, `focus`.
- Statusbar density: `off`, `compact`, `full`.
- Theme: `dark`, `light`.
- Hide/show thinking blocks.
- Tool detail default: collapsed or expanded.
- Hardware cursor support.
- Clear-on-shrink support.
- Terminal progress visibility.
- Subagent display density.

Runtime and gateway needs:

- Define which settings are local visual settings and which require runtime
  persistence.
- Add a settings load/save path through config or a dedicated TUI settings RPC.
- Make updates immediate when possible.

Current implementation notes:

- The gateway exposes `settings.load` and `settings.save` JSON-RPC methods.
- Python owns validation and persistence through `mycli.config.tui_settings`.
  The user-level config file stores durable values such as `view_mode`,
  `tui_statusbar_mode`, `tui_theme`, `tui_hide_thinking`,
  `tui_tool_details_default`, cursor/resize/progress flags, and
  `tui_subagent_density`.
- The Node TUI loads settings at bootstrap and submits selector changes through
  `settings.save`. The selector can optimistically update presentation, but the
  saved runtime payload remains authoritative.
- The TypeScript adapter accepts snake_case gateway payloads and projects them
  into `MycliShellVisualSettings` camelCase state.
- `/settings` now includes searchable rows for the planned settings surface:
  view mode, statusbar density, theme, thinking visibility, tool detail default,
  hardware cursor, clear-on-shrink, terminal progress, and subagent density.

Acceptance markers:

- `/settings` is enough to discover and change the main TUI behaviors.
- Settings survive restart when they are documented as persistent.
- Settings changes do not require transcript rebuild side effects.

## Phase 4 - Tool And Bash Presentation Upgrade

Priority: medium.

Reason: tool clarity is central to coding-agent trust, but direct pi-agent
`tool-execution.ts` reuse would over-couple mycli to pi-agent's tool renderer
system.

Reference components:

- `coding-agent/src/modes/interactive/components/tool-execution.ts`
- `coding-agent/src/modes/interactive/components/bash-execution.ts`
- `coding-agent/src/modes/interactive/components/diff.ts`

Target capabilities:

- Keep `MycliShellTool` and `MycliShellBash` as gateway-owned presentation
  models.
- Introduce a mycli tool presentation registry keyed by canonical tool name.
- Specialize Read, Glob, Grep, LS, Write, Edit, Patch, Bash, Task/subagent.
- Keep routine read/search tools collapsible or groupable by default.
- Always show mutating, failed, denied, and shell tools.
- Show duration, exit code, truncation, and log/detail hints.
- Support bounded diff previews.
- Later, add image result support behind terminal capability checks.

Acceptance markers:

- Tool output remains bounded at narrow widths.
- `ctrl+o` expands and collapses consistently.
- Failed tools show a reason without dumping raw output.
- Bash output shows tail preview, exit status, and hidden line count.

Current implementation notes:

- `components/tool-presentation.ts` is the mycli-owned registry for labels,
  icons, semantic accent colors, bounded preview line counts, and concise result
  summaries.
- `ToolExecutionComponent` and `BashExecutionComponent` now consume the registry
  instead of carrying separate preview constants and naming rules.
- The runtime-state adapter applies the persistent `toolDetailsDefault` setting
  to tool and bash transcript projection, while explicit folded/unfolded
  transcript state still wins.

## Phase 5 - Resource Manager

Priority: medium.

Reason: hooks, plugins, skills, prompts, and themes become hard to manage once
they exist beyond toy scale.

Reference component:

- `coding-agent/src/modes/interactive/components/config-selector.ts`

Target capabilities:

- Group resources by user, project, package/source, and type.
- Display enabled/disabled state.
- Search resources.
- Toggle runtime-backed resources through approved commands.
- Show allowlist/security state for hooks.

Initial resource types:

- hooks
- plugins
- skills
- prompts
- themes

Acceptance markers:

- `/tools hooks`, `/tools plugins`, and `/tools skills` have an interactive
  path, not only text dumps.
- Toggling a resource goes through runtime enforcement.
- Disabled or unsafe resources explain why they are unavailable.

Current implementation notes:

- The gateway exposes a read-only `resource.list` RPC. It aggregates bounded,
  already-sanitized runtime inspect output for hooks, plugins, and skills, plus
  static prompt/theme entries that route users to existing runtime-owned
  surfaces.
- The Node TUI owns `ResourceSelectorComponent` for search, type filtering,
  preview detail, and keyboard selection.
- `/resources` opens the local resource overlay. Selecting a row runs the
  resource's runtime inspect command such as `/tools hooks`, `/tools plugins`,
  `/tools skills`, `/help`, or `/settings`.
- Resource toggling is intentionally not implemented in the TUI layer yet.
  Future toggles must call runtime-backed commands/RPCs that enforce hook
  allowlists, plugin enablement policy, and any required approvals.

## Phase 6 - Theme System

Priority: medium-low.

Reason: useful, but not before the core session/tool/settings surfaces are
solid.

Reference files:

- `coding-agent/src/modes/interactive/theme/theme.ts`
- `coding-agent/src/modes/interactive/theme/*.json`

Target capabilities:

- Expand semantic tokens before adding user theme files.
- Keep dark and light built-ins stable.
- Respect `NO_COLOR`.
- Preserve readable 256-color fallback.
- Add JSON theme loading only after semantic token coverage is complete.
- Add file watching only after loading is stable.

Acceptance markers:

- Components do not hard-code raw colors outside the theme layer.
- Diff/tool/status/thinking/subagent states have semantic colors.
- Light theme and no-color mode are usable.

Current implementation notes:

- The theme layer now includes semantic tokens for selector titles/matches,
  resources by type and status, session tree state, and subagent status.
- `ResourceSelectorComponent` uses resource-specific tokens for hook, plugin,
  skill, prompt, theme, enabled, disabled, and issue states.
- Subagent execution rendering uses subagent-specific running/completed/failed
  tokens instead of generic warning/success/error names.
- This phase still avoids user theme file loading. JSON theme compatibility
  remains deferred until semantic token coverage is broad enough to avoid raw
  color leakage.

## Cross-Layer Work Items

These items cut across phases and should be handled deliberately:

- Gateway event and request schema versioning.
- State projection tests from Python to TypeScript.
- Keyboard action naming and key hint reuse.
- Width safety for every new component.
- Empty-state copy for selectors.
- Runtime-backed persistence for settings and resource toggles.
- Documentation for which behaviors are local TUI state vs durable runtime
  state.

## Verification Strategy

Every phase should include:

```bash
cd tui/mycli-shell
npm run typecheck
npm test
cd ../..
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py -q
git diff --check
```

When Python runtime projection changes, add targeted integration tests in
`tests/unit/cli/node_tui/` or `tests/integration/test_node_tui_gateway.py`.

When a component has non-trivial keyboard behavior, add focused TypeScript tests
in `tui/mycli-shell/test/`.

## Implementation Order

Recommended order:

1. Extract/adapt session selector search utilities.
2. Upgrade `MycliShellSession` and session gateway projection.
3. Replace the current simple `SessionSelectorComponent` with the richer
   mycli-owned version.
4. Add conversation tree payload and selector.
5. Expand settings selector and persistence.
6. Add mycli tool presentation registry.
7. Add resource manager.
8. Expand theme system.

This order keeps each step useful on its own and avoids a risky full TUI
rewrite.

## Open Questions

- Should session rename/delete be runtime commands first, or dedicated RPCs?
- Should conversation tree selection scroll the existing transcript or open a
  preview overlay first?
- Which settings should be user-level defaults vs workspace-level overrides?
- Should resource toggles be immediate or staged with an apply/confirm action?
- How much pi-agent theme JSON compatibility is worth preserving?

## First Implementation Slice

The first slice should be Phase 1 without rename/delete:

```text
session search utilities
  -> richer MycliShellSession metadata
  -> title-first session selector
  -> current/all scope
  -> recent/relevance sorting
  -> tests
```

This gives an immediate TUI quality improvement while preserving the current
runtime ownership boundary.

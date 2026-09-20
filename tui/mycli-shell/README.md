# mycli Shell TUI

The TUI consumes canonical gateway contracts and presents terminal interactions. Backend turn
execution, storage, providers, tool permissions, and shell processes remain owned by the backend.

## Module Ownership

| Source path | Responsibility |
| --- | --- |
| `index.ts` | Public package API; internal modules import their owners directly |
| `gateway.ts` | Public gateway entry, startup/shutdown exports, standalone signal wiring |
| `application/` | Gateway session composition, interactive/native runtimes, UI callbacks and session lifetimes |
| `state/` | Wire-to-view conversion, event ownership/reduction, input queues, settings, catalogs and history recovery |
| `transcript/` | Display-independent grouping, search classification, detail projection and replay limits |
| `components/transcript/` | Transcript cells, shared block factory/renderer, viewport and history viewer |
| `components/selectors/` | Approvals, clarification, settings, model/session pickers and onboarding surfaces |
| `components/composer/` | Editor, queued-input preview, work summary and session footer |
| `components/shared/` | Reusable component layout, markdown themes, truncation and frame caching |
| `interaction/` | Typed UI actions, application keybindings, slash commands and plan choices |
| `transport/` | Shared gateway client adapter, event deduplication, handshake and configured transport |
| `platform/` | TTY streams, clipboard and fatal diagnostic persistence |
| `theme/` | Semantic colors and terminal glyph policy |
| `tui-core/` | Application-independent terminal engine, screen buffers, input decoding and primitive widgets |
| `model.ts` | Shared view types, transcript update hints and pure view-model queries |

`safe-ui-text.ts`, `stable-variant.ts`, and `version.ts` are package-wide primitives. `demo.ts`
and `setup.ts` remain executable entry points. Tests mirror their source owner where applicable;
cross-feature regression tests remain at `test/`, with reusable fixtures in `test/support/` and
`test/fixtures/`.

## State And Rendering

```text
gateway notification
  -> transport/gateway-events: decode and deduplicate
  -> state/runtime-event-reducer: check ownership and update runtime state
  -> state/runtime-projection: map runtime state to MycliShellState
  -> transcript/: apply detail mode and group read/search activity
  -> components/transcript/transcript-block: create or update cells
  -> components/transcript/transcript-viewport: retain rows and scrollback
  -> tui-core/: render terminal cells

keyboard input
  -> interaction/ui-actions
  -> application/gateway-session
  -> configured gateway transport
```

`state/runtime-event-reducer.ts` is the event dispatch entry. It delegates shell, tool, message,
plan, subagent, decision, and queue updates to their owners. `session-state.ts` composes pure bootstrap
and resume transitions; `transcript-history.ts` merges pages and legacy records.
`application/session-transition.ts` owns asynchronous history recovery for both slash commands and
the session picker. Its injected loader reads history, while session generations and a load revision
prevent late responses from replacing a newer session or a cleared view.

`RuntimeStateProjector` binds the view mapping to the incremental cache in
`runtime-transcript-projector.ts`. Event reduction does not depend on rendering components.
State-generated legacy reasoning/compaction labels may use `theme/terminal-style.ts` glyphs;
state modules cannot depend on the terminal engine or component layer.

`application/shell-runtime.ts` owns the interactive session and connects the editor, selectors,
transcript, status and footer. Viewport caching, activity animation, tool detail projection and
transcript cell creation each have a separate owner. Static output, native output and the history
viewer use the same transcript block factory as interactive rendering.

Gateway startup paints in two phases. `application/gateway-session.ts` opens the TTY and starts the
shell as soon as the module is loaded, then awaits `runtime.ready`, `session.bootstrap`, the
transcript and the catalogs while the user already sees the composer and footer. The runtime is
constructed with `deferStartupGates`, so the trust, credential, model, connectivity and permission
gates are evaluated by `applyStartupGates` once the first session payload arrives. Submissions
made before that payload is applied are rejected with a notice instead of reaching the gateway
without a session, and composer text typed during the wait becomes the activating session's draft.
If bootstrap fails, the shell restores the terminal before the entry reports the failure.

## Composer Layout

The current activity follows the last output line with one blank row between them. Spare rows
stay below that activity and above the work summary and editor. The editor and session footer
remain at the bottom even when the transcript is short or the turn's activity appears/disappears.

The input area has fixed responsibilities, from top to bottom:

1. The current turn's activity follows the agent output, before all input-related summaries.
   It owns elapsed time, interruption hints and bounded retry details. Live status is never
   repeated in the footer or committed to transcript history.
2. A work summary combines Goal state and background Shell count. Goal controls and `/ps` appear
   when space permits. Plan progress appears in transcript updates. Extension statuses share at
   most one additional row; duplicates and blank entries are omitted, and overflow is counted.
3. Queued messages and background agents keep their own bounded previews above the editor.
4. Below the editor, the first footer row shows mode/trust, model and reasoning on the left,
   with context usage on the right. The second shows the workspace/branch and session name.

`tui.statusbar_mode = "full"` shows both footer rows; `"compact"` keeps the first, and `"off"`
hides the footer. If model context is unavailable, compact mode falls back to workspace context.
Work summaries and pending interactions remain visible independently of that setting. The
`terminal_progress` setting continues to control the running activity indicator.

Metadata uses the editor's inset and avoids the terminal's wrap column. Narrow widths omit
reasoning and branch details before truncating longer labels; trust/mode and Goal status take
priority. Exact Goal usage and continuation counts remain available through `/goal`.
Work-only updates invalidate their summary without rebuilding the session footer or transcript.

## Input And Pasted Text

Ordinary text stays inline. A bracketed paste with more than 1,000 Unicode characters or 10 lines
appears as `[paste #1 1234 chars]` or `[paste #1 +25 lines]`. The marker is an atomic editor item;
deleting it and undoing restores its associated text. Enter and the follow-up shortcut expand
all bound pastes before submitting the message. Text inside a paste is expanded only once, so
literal marker-looking text remains literal.

Unsent input and folded paste bodies stay in memory. Switching sessions within the same TUI run
keeps each session's draft, cursor, image descriptors and selected skill references. Failed
submissions restore the source session's input and preserve any newer text. Restarting mycli
opens an empty composer; drafts are not written to disk or restored from local files.

Unsent drafts stay outside conversation history and training exports. Submitted messages use
their expanded text in the existing transcript flow. Folding does not reduce context usage.
Large pastes continue to use full-text submission with the editor's existing text normalization.

## Integration Inspection

`/mcp [verbose]`, `/plugins`, `/skills`, and `/hooks` have independent entries in command discovery
and the settings center. `/tools [list|sets]` remains a search-only diagnostic inventory of callable
tools. Retired `/tools plugins`, `/tools hooks`, and `/tools extensions` forms return replacement
hints from the backend registry.

MCP catalog entries use `type: "mcp"` and represent servers, including loading, disabled, failed,
and cached states. Plugin entries represent packages; their contributed capabilities appear in
details. A plugin's MCP servers also appear in the MCP catalog, and its tools in the tool inventory.

`CommandResultOverlayComponent` owns list filtering, navigation, and scrollable details. Enter
inspects a row without invoking a tool or plugin command. Esc returns before closing, and resize
preserves the selection and composer draft. Plugin package management remains in the CLI; see
[Plugin compatibility](../../docs/plugin-codex-parity.md) for the supported scope.

## Invariants

- Keep all internal imports direct. Do not route implementation imports through the package facade.
- `tui-core/` never imports application, state, theme or product components. Generic image-path
  detection lives with terminal image support; attachment placeholder allocation is application code.
- Components consume view models and callbacks, not gateway clients or runtime state reducers.
- `transcript/` computes display data without importing components or application controllers.
- Only `transport/` imports `@mycli/gateway`; contracts can be consumed throughout the TUI.
  No TUI module imports backend implementation packages.
- Preserve immutable event state, active-session/generation checks, and source IDs during recovery.
  A late async callback must not reclaim another session's UI or replace its state.
- A session activation clears the previous transcript before accepting the new session's events.
  History recovery retains restored decisions, background terminals, and newer live transcript rows.
- Slash command discovery refreshes after extension updates for the palette, autocomplete, and both
  runtime routing tables. An open palette reads current turn availability; opening the session picker
  refreshes its list without losing the composer draft.
- Local `transcript.clear` and `view.set` actions update the gateway session's UI state. They do not
  mutate backend history or user configuration, and ordinary gateway updates cannot undo them.
- Keep assistant and running-tool components stable during streaming. Assistant updates must not
  serialize complete blocks, and expanded shell output must retain its elapsed-time clock.
- Transcript owners increment the content revision before changing visible content. Validated tail
  hints retain a stable prefix; session replacement and changed grouping context invalidate it.
- Keep native scrollback commitment and transcript viewer lifetime separate from status animation.
- Paint the shell before `runtime.ready` only through the deferred gate path: startup gates wait for
  `applyStartupGates`, submissions are refused until the first payload is applied, and a bootstrap
  failure restores the terminal before the entry reports it.

`test/architecture.test.ts` checks dependency direction, unresolved internal imports, backend
isolation, and cycles, including type-only imports. Package type checking also rejects unused
locals and parameters.

## Verification And Packaging

```sh
npm run typecheck --workspace mycli-shell-tui
npm test --workspace mycli-shell-tui
npm run build
```

The public package subpaths remain `.`, `./gateway`, and `./gateway-transport`. Development uses
the `mycli-source` condition; ordinary consumers load `dist/`. TUI builds clean `dist/` before
compilation so moved files cannot survive as obsolete compiled modules. Root package tests and
the packed CLI smoke verify source, JavaScript and declaration resolution.

## Operation feedback

`/compact` immediately shows **Compacting context** with a separate timer. Press Esc or Ctrl+C
once to cancel. Completed, cancelled and failed compactions have distinct results; repeated
compactions keep separate rows. The Working timer resumes after automatic compaction. The
input editor and footer remain anchored at the bottom, with live activity next to agent output.

Model changes confirm the selected provider/model, reasoning effort and session/user scope.
Approval decisions remain visible in the current conversation view. Routine information uses
neutral styling, while warnings and failures keep their own colors. Idle Ctrl+C shows an exit
hint below the input; it clears after two seconds or further input.

MCP startup shows server progress, and failures point to `/mcp`. Slow hooks show their execution
phase; hook failures point to `/hooks`. Settings-load failures explain the fallback. Goal budget
interruptions include `/goal` recovery instructions and retain their meaning after resume.
Retry rows show the action and reason; expand them to inspect provider and retry-budget details.

Terminal notifications are enabled by default when the terminal reports that it is unfocused.
They announce turn completion or a request for approval, an answer or plan review, without
including conversation contents. Toggle **Terminal notifications** in `/settings`, or set
`tui_terminal_notifications = false` in your user config. Notifications use OSC 9; the terminal
emulator must support focus reports and notifications. They are cleared when the runtime stops.

A gateway disconnect prints the session recovery command. This does not automatically reconnect
to a dead backend. Account-quota prewarnings also depend on provider-supplied quota data and are
not inferred from context usage or local token counts.

# mycli TUI Development Roadmap

This roadmap turns `docs/parity/tui-experience-blueprint.md` into implementation batches. The goal is a professional local coding-agent TUI: Python runtime remains the source of truth, Node/Ink owns terminal interaction, and risky actions stay visible and recoverable.

## Current Baseline

Already present:

- Real Node/Ink runtime app entry exists in `tui/node/src/index.tsx`.
- TTY split exists through `/dev/tty` in `tui/node/src/terminal/tty.ts`.
- Python gateway and typed JSON-RPC contracts exist.
- Approval, clarification, tool lifecycle, gateway errors, and scripted smoke tests exist.
- Transcript has been moved away from heavy per-turn cards into lightweight prompt/tool/prose rows.

Known gaps:

- Terminal hygiene is not yet fully productized: resize, alternate-screen policy, non-TTY fallback, and crash recovery need explicit behavior and tests.
- Tool failure rows are still too generic.
- Trust state is not yet a first-class TUI/runtime contract.
- Slash command discovery and long-session controls need a catalog-driven UI.
- Busy input queue, diff-first flow, and session continuity need stronger product surfaces.

## Batch P0.1 - Transcript And Tool Failure Clarity

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make coding turns readable and failures diagnosable without flooding the transcript.

Scope:

- Keep lightweight transcript rows: user prompt glyph, folded tool trail, assistant prose.
- Extend `ToolSummary` with compact failure reasons and action hints.
- Render failed tools as one-line summaries with stable glyphs and detail pointers.
- Keep raw stdout/stderr hidden by default; verbose mode may show structured details.

Acceptance markers:

- Tool rows can render running, success, failed, approval, and queued-like states.
- Bash failures show `exit N`; timeouts show `timeout Ns`; denied approval shows `denied`.
- Failed rows can include duration and a detail/log hint without dumping raw output.
- Node tests lock that transcript does not regress to `Turn`, `[assistant]`, or `[tools]` cards.

Verification:

```bash
cd tui/node
npm run typecheck
uv run npm test
cd ../..
uv run ruff check src tests evaluation
uv run mypy src/mycli
uv run pytest -q
git diff --check
```

## Batch P0.2 - Terminal Hygiene And Gateway Diagnostics

Status: completed for the first foundation pass in `feature/mycli-termcn-tui-polish`.

Goal: make the TUI safe to enter and safe to leave.

Scope:

- Document and test Ctrl-C behavior: overlay cancel, running-turn interrupt, input clear, idle exit.
- Add actionable gateway startup/crash diagnostics in the TUI.
- Add non-TTY fallback behavior for environments without `/dev/tty`.
- Make resize handling explicit, even if the first pass only updates width and redraws.
- Ensure shutdown requests are best-effort and terminal streams close on exit.

Acceptance markers:

- Ctrl-C behavior is deterministic in reducer/app tests.
- Gateway request failures render bounded diagnostics with method/code/detail.
- Non-TTY startup fails gracefully or falls back to scripted/plain mode with a clear message.
- Exit does not leave the process hanging.

Remaining follow-up risk:

- Full alternate-screen policy and resize/redraw behavior still need a deeper runtime pass.
- Approval and clarification cancellation should stay runtime-owned; the TUI currently avoids silently clearing those pending states.

## Batch P0.3 - Workspace Trust And Approval Hardening

Status: completed for the first foundation pass in `feature/mycli-termcn-tui-polish`.

Goal: make risky local actions understandable and enforceable.

Scope:

- Add trust status to runtime state and typed gateway contract.
- Add `workspace.trust.status` and `workspace.trust.set`.
- Add `TrustPrompt` in PromptZone before risky execution.
- Harden approval overlay copy: action, cwd, risk, decision id, and choices.
- Ensure rejection produces a recoverable terminal turn state, not a crash.

Acceptance markers:

- New workspace can render a trust prompt.
- Untrusted mode is visible in status line.
- Approval rows show stable decision id and risk details.
- Tests cover approval accept/reject/session allow rendering and reducer state.

Completed foundation:

- `workspace.trust.status`, `workspace.trust.set`, and `workspace.trust.changed` are typed in the gateway contract.
- Bootstrap/status payloads can carry optional trust state without making older status events invalid.
- Node shell state, header, status line, and welcome panel display trusted/untrusted/unknown trust state.
- `TrustPrompt` renders before approval prompts and routes trust choices back through the gateway.
- `ApprovalPrompt` shows decision id, action, cwd, risk, risk reason, and runtime-provided choices.
- Gateway fallback explicitly reports `enforced: false` when runtime trust enforcement is unavailable.

Remaining follow-up risk:

- Workspace trust runtime enforcement is not productized yet; Python runtime policy must remain the source of truth before untrusted mode can actually block tool execution.
- Dedicated runtime-backed trust persistence is still needed if trust decisions should survive process/session restarts.

## Batch P1.1 - Slash Catalog And Completion

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make capabilities discoverable from the composer.

Scope:

- Add a catalog model for slash commands: name, aliases, category, description, mutating flag.
- Drive `/help` and completion popup from the catalog.
- Add or reserve commands from the blueprint: `/model`, `/compact`, `/retry`, `/queue`, `/title`, `/statusbar`, `/details`.
- Keep runtime-backed commands behind `command.run` until dedicated RPCs exist.

Acceptance markers:

- Completion shows category and description.
- Unknown slash commands suggest nearest matches.
- Mutating command output echoes the effective state.

Completed:

- Slash commands are registered in a typed Node catalog with name, aliases, category, description, mutating flag, and route metadata.
- `/` input opens catalog-backed completion, supports prefix filtering, selection movement, Tab accept, and Esc close.
- Completion rows show command category, read/mutating status, and description.
- `/help` and `/?` render from the catalog instead of hand-written command help.
- Unknown slash commands open a local suggestion overlay with nearest catalog matches.
- Known runtime commands still route through `command.run`; Node only handles local display commands directly.

Command routes:

- Local Node commands: `/help`, `/?`, `/theme`, `/clear`.
- Runtime-backed commands: `/view`, `/status`, `/context`, `/usage`, `/sessions`, `/resume`, `/quit`.
- Catalog-reserved runtime fallback commands: `/model`, `/compact`, `/retry`, `/queue`, `/title`, `/statusbar`, `/details`, `/trust`.

Remaining follow-up risk:

- Reserved commands depend on Python runtime support behind `command.run` or future dedicated RPCs.
- Path completion still exists as a gateway capability, but this batch only productized slash command completion in the Node composer.

## Batch P1.2 - Session Continuity

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: long tasks can be resumed deliberately without accidental old-context inheritance.

Scope:

- Make fresh-session default explicit in TUI startup copy.
- Add `/sessions`, `/resume`, `/title` UX improvements.
- Print or render resume hints on exit where appropriate.
- Track pending approval/suspended turn only under explicit resume.

Acceptance markers:

- Plain TUI startup does not auto-attach to recent sessions.
- Resume picker/list is clear and bounded.
- Session title is visible in header/status when present.

Completed:

- Startup copy now points users toward explicit `/sessions` and `/resume <session>` flows.
- `/sessions` routes through the typed `session.list` RPC and renders bounded overlay rows with id, current marker, last active, and message count.
- `/resume <session_id>` routes through typed `session.resume`, updates state from runtime events, and reloads transcript history for the active session.
- Missing `/resume` arguments render a local usage overlay instead of calling the runtime with invalid params.
- Optional session title is carried through bootstrap/status payloads and displayed in Header/StatusLine when present.
- Pending approval/clarification remains runtime-owned; resume may re-emit pending state, but Node does not locally clear it.

Remaining follow-up risk:

- `/title` is still a catalog/runtime fallback; durable title persistence needs runtime command or dedicated RPC support.
- Resume picker is an overlay list rather than an interactive selectable list; keyboard picker polish belongs in a later pass.

## Batch P1.3 - Diff-First Coding Flow

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: users can see what changed, how it was tested, and how to recover.

Scope:

- Improve `/changes` and `/diff` overlays.
- Show per-turn touched files and summary counts.
- Add final summary fields for tests run and not-tested gaps.
- Keep `/undo` and `/checkpoint` explicit and conservative.

Acceptance markers:

- File mutations produce visible changed-file summaries.
- Failed tests point to logs/details instead of flooding transcript.
- `/changes` and `/diff` output is structured and page-able.

Completed:

- Slash catalog now exposes `/changes`, `/diff`, `/undo`, and `/checkpoint` with conservative routing metadata.
- `/changes` routes through runtime `command.run` and opens as a bounded overlay with `file changes` presentation hint.
- `/undo` routes through runtime `command.run`; Node does not implement local undo semantics.
- `/diff` and `/checkpoint` are reserved runtime fallbacks until Python support exists.
- Tool rows parse runtime `metadata.file_changes` into compact per-turn summaries with changed file count, add/modify/delete counts, and a bounded path preview.
- Failed tools keep raw stdout/stderr/diff hidden by default while preserving compact failure reason and detail/log hints.
- Overlay output remains bounded and displays a truncation marker for long change/diff output.

Remaining follow-up risk:

- Python runtime does not yet expose a dedicated `/diff` or `/checkpoint` command; Node only discovers and routes them conservatively.
- Final assistant summary fields for `tests_run` and `not_tested` depend on runtime metadata emission. Node keeps message metadata bounded but does not invent missing test evidence.

## Batch P2 - Long Session Comfort

Status: completed for the first product pass in `feature/mycli-termcn-tui-polish`.

Goal: improve comfort after the primary loop is reliable.

Scope:

- Large paste collapse and paste diagnostics.
- Transcript history/search/export/copy.
- Statusbar/details/redraw/terminal-setup controls.
- Mouse wheel support only after keyboard flow is complete.
- Subagent dashboard only after delegation state is mature.

Completed:

- Large input/paste display now collapses long or multi-line drafts in the composer while retaining the full draft for submission.
- Paste diagnostics show line count and character count so long input does not flood the terminal frame.
- Local `/history` opens a bounded visible transcript preview overlay.
- Local `/search <query>` searches the visible transcript and renders bounded matches in an overlay.
- Local `/export` previews a bounded transcript export without writing files.
- Local `/copy` shows the latest assistant message for manual copy without touching the clipboard.
- `/redraw` is a discoverable reserved runtime fallback.
- `/terminal-setup` is now a local read-only terminal diagnostics overlay.
- `/statusbar` and `/details` are local TUI controls and are discoverable through catalog/help.

Remaining follow-up risk:

- `/history`, `/search`, `/export`, and `/copy` are local visible-transcript conveniences; durable historical search/export still needs runtime-backed storage APIs if older unloaded history should be included.
- Clipboard integration is intentionally not implemented in Node yet; `/copy` is a manual copy preview to avoid hidden side effects.
- Mouse wheel support and subagent dashboard remain deferred until keyboard flow and delegation state contracts are more mature.

## Batch P2.1 - Tool Visibility Policy

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: reduce transcript noise so routine tool churn does not flash through the main chat view.

Scope:

- Keep tool lifecycle events in state, but make default transcript rendering selective.
- Treat successful `Read` and `Grep` as low-value exploration rows that are hidden in default/focus views.
- Keep mutating tools, shell commands, failed tools, and changed-file summaries visible.
- Keep `verbose` mode as the escape hatch for the full tool trail and raw tool details.
- Compact workspace-local absolute paths before rendering tool rows.

Completed:

- `ToolSummary` now has a visibility classifier: `verboseOnly`, `summary`, and `important`.
- Default transcript hides successful `Read`/`Grep` and running tool rows.
- Default transcript still shows `Edit`, `Write`, `Bash`, failed rows, and rows with changed-file summaries.
- `/view verbose` shows the hidden read/grep trail and tool detail rows.
- Tool target rendering compacts workspace absolute paths and deduplicates case-varied path duplicates.

Remaining follow-up risk:

- Startup transcript restoration still loads a bounded history window; a later pass should add a dedicated restored-history summary or viewport policy if old turns remain visually heavy.
- Runtime can emit richer tool importance metadata later; Node currently infers visibility from formatted summary fields.

## Batch P2.2 - Restored History Viewport

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: keep session restoration useful without flooding the first screen.

Scope:

- Bound default transcript rendering to a recent turn window.
- Keep full restored history available in `/view verbose`.
- Keep `/view focus` pinned to the latest turn.
- Render a concise hidden-history hint instead of expanding every restored turn.

Completed:

- Default view now shows only the latest four turns.
- When older turns are hidden, the transcript renders `N earlier turns hidden · /view verbose`.
- Verbose mode still renders all loaded turns and hidden tool/detail rows.
- Focus mode still renders only the latest turn.

Remaining follow-up risk:

- This is a render-time viewport, not an interactive scrollback. A future pass can add keyboard paging once focus management is mature.
- The gateway still loads up to 200 transcript items; reducing load volume should be a separate runtime/session policy decision.

## Batch P2.3 - View Mode Feedback

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make transcript density changes visible and self-explanatory.

Scope:

- Show the active view mode in stable header/status metadata.
- Make `/view` a local UI command so density changes do not depend on runtime support.
- Keep command feedback short while explaining what default and verbose modes change.

Completed:

- Header and status line now include `view: default|verbose|focus`.
- `/view` without arguments reports the current local mode and usage.
- `/view default|verbose|focus` updates local state and emits a compact transcript confirmation.
- `/view verbose` confirmation explains that verbose shows all loaded details, while default hides older turns and routine read tools.

Remaining follow-up risk:

- View mode is session-local UI state; persistence across restarts should be a later config/session setting if users ask for it.

## Batch P2.4 - Semantic Running Activity

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make live activity readable while keeping routine tool churn out of the transcript.

Scope:

- Keep raw tool lifecycle rows available through transcript state and verbose mode.
- Derive a user-facing live phase from recent tool summaries.
- Prefer runtime live status when the runtime has a stronger state such as waiting approval.

Completed:

- Running activity now maps read/grep to `Reading`, edit/write to `Editing`, test-like shell commands to `Testing`, and other shell commands to `Running command`.
- Activity details show the latest useful path or command instead of a raw tool-name chain.
- Runtime live status still wins for states such as `Waiting approval`.
- The lower-level recent tool path remains available for diagnostics and tests.

Remaining follow-up risk:

- The phase classifier is heuristic until Python emits explicit activity kind metadata.

## Batch P2.5 - Busy Input Queue

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make follow-up input during a running turn predictable instead of submitting into an active turn.

Scope:

- Queue normal user prompts locally while a turn is running.
- Keep slash commands available during running turns.
- Show queued count in status metadata.
- Provide a local `/queue` overlay so users can inspect queued prompts.
- Submit one queued prompt automatically when the active turn reaches a terminal state.

Completed:

- `ShellState` now tracks `queuedInputs` and one `pendingQueuedSubmit`.
- Enter during a running turn queues ordinary input and records a compact system notice.
- `turn.status` terminal events and `turn.completed` both drain the next queued prompt.
- RuntimeApp consumes `pendingQueuedSubmit` and submits it through the existing `turn.submit` path.
- Status line metadata displays `queue: N` when follow-up prompts are waiting.
- `/queue` is now a local command that opens a bounded queued-input overlay.

Remaining follow-up risk:

- Queue editing, deletion, and steer/interrupt modes are not implemented yet; this pass intentionally implements only the blueprint's minimum `queue` strategy.

## Batch P2.6 - Context Pressure Hint

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make context pressure visible before users hit degradation or compaction surprises.

Scope:

- Detect high context usage from the runtime `context_window` status payload.
- Mark high pressure directly in the existing `ctx` status segment.
- Suggest `/compact` when context pressure crosses the warning threshold.
- Keep the behavior local to TUI rendering; Python runtime remains the source of token counts.

Completed:

- `formatContextUsage` now appends `high` at 80% or greater context usage.
- Status metadata and StatusLine render `/compact suggested` when context pressure is high.
- The context status pill width was widened so high-pressure context text remains readable.
- Tests cover normal context usage, missing context, and high-pressure compact hints.

Remaining follow-up risk:

- The threshold is a fixed UI heuristic. A later runtime policy can emit provider/model-specific pressure levels if needed.

## Batch P2.7 - Details Command Alias

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make tool/reasoning detail visibility discoverable through the command vocabulary named in the blueprint.

Scope:

- Keep the existing `viewMode` model as the implementation source of truth.
- Make `/details` a local TUI command rather than a reserved runtime fallback.
- Map simple details controls onto the existing transcript density modes.

Completed:

- `/details` is now cataloged as a local view command.
- `/details on` and `/details verbose` switch to `viewMode=verbose`.
- `/details off` and `/details default` switch to `viewMode=default`.
- `/details focus` switches to `viewMode=focus`.
- Bare `/details` opens a compact usage overlay that explains detail visibility.

Remaining follow-up risk:

- This is still a coarse alias over `viewMode`; per-domain toggles such as `/details tools on` or `/details reasoning off` remain future work.

## Batch P2.8 - Statusbar Controls

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: let users reduce or restore composer metadata noise without involving Python runtime state.

Scope:

- Keep Python runtime as the source of truth for session, model, trust, context, approvals, and live turn state.
- Add local `statusbarMode` state with `full`, `compact`, and `off`.
- Make `/statusbar on|off|compact|full` a local command.
- Keep `on` as an alias for `full`.
- Apply the mode to composer metadata and reusable status line rendering.

Completed:

- Default mode remains `full`, preserving the existing session/model/trust/theme/view/queue/context/live metadata.
- `compact` shows only session, model, queue, context pressure, live state, and pending approval/clarification markers.
- `off` hides composer metadata only; header, transcript, runtime state, and prompts remain visible.
- Bare `/statusbar` opens a compact usage overlay with the current local mode.
- Tests cover command routing, reducer state changes, status metadata, and App rendering.

Remaining follow-up risk:

- Statusbar mode is local UI state and is not persisted across TUI restarts.

## Batch P2.9 - Terminal Setup Diagnostics Overlay

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make terminal/color setup inspectable from inside the TUI without shell side effects.

Scope:

- Make `/terminal-setup` a local read-only command.
- Show Node-visible TTY state, color depth, theme, statusbar mode, and relevant environment variables.
- Include bounded hints for color forcing, `NO_COLOR`, and tmux truecolor.
- Avoid executing external commands or changing terminal configuration.

Completed:

- `/terminal-setup` opens a local overlay with `stdin_tty`, `stdout_tty`, `color_depth`, `NO_COLOR`, `MYCLI_TUI_COLOR`, `MYCLI_TUI_THEME`, `TERM`, `COLORTERM`, `TMUX`, theme, and statusbar mode.
- The overlay is bounded through the same local overlay path as other local commands.
- Tests cover the visible diagnostic fields.

Remaining follow-up risk:

- Diagnostics reflect the Node process environment only; deeper terminal probing should remain a later explicit runtime/TTY capability.

## Batch P2.10 - Queue Visibility Polish

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make the local busy-turn queue inspectable and safely clearable.

Scope:

- Keep queued prompts local to the Node TUI.
- Keep `/queue` as a bounded queue preview.
- Add `/queue clear` to drop queued follow-up prompts when the user changes their mind.
- Do not interrupt or mutate the active Python runtime turn.

Completed:

- `/queue clear` clears `queuedInputs` and `pendingQueuedSubmit`.
- Empty queue clearing reports a short local command output instead of failing.
- `/help` and welcome copy now mention the new local controls.
- Tests cover local command recognition, command catalog routing, reducer behavior, and welcome/help copy.

Remaining follow-up risk:

- Queue editing, reordering, and dropping a single queued prompt remain future work.

## Batch P2.11 - Context And Usage Overlay Formatting

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: make runtime-backed `/context` and `/usage` output easier to scan when structured data is available.

Scope:

- Keep `/context` and `/usage` runtime-backed commands.
- Format known structured result fields in the Node reducer before rendering overlays.
- Preserve raw `lines` fallback when the runtime only returns plain text.
- Avoid inventing context or usage data in Node.

Completed:

- `/usage` overlays can render structured input/output/total token counts, request counts, and cost.
- `/context` overlays can render used/max/remaining token counts, pressure/source, and bounded context source rows.
- Explicit runtime `presentation_hint` is still respected; otherwise Node defaults to `usage` or `context`.
- Tests cover structured usage and context overlays.

Remaining follow-up risk:

- Runtime result shapes are still permissive. A later gateway contract can make context/usage schemas explicit.

## Batch P2.12 - Tool Failure Detail Preview

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: show useful failure detail without dumping raw stdout, stderr, tracebacks, or large output into the transcript.

Scope:

- Extend the local `ToolSummary` display model with a bounded `preview` field.
- Derive previews only from structured short fields such as `error_message`, `message`, `summary`, or `error`.
- Keep stdout/stderr/raw output hidden by default.
- Continue showing reason, duration, side-effect hint, and log/details reference when available.

Completed:

- Failed tool rows can include a bounded structured error preview.
- Duplicate preview/reason values are suppressed.
- Tool row rendering includes preview between duration/reason and side-effect/log hints.
- Tests cover preview extraction and ensure raw stdout/stderr fields are not surfaced.

Remaining follow-up risk:

- Interactive expansion of a selected failed tool still needs focus/selection state before it can be productized.

## Batch P3.0 - pi-tui Prototype Spike

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: evaluate whether the imported `pi-tui` renderer/editor stack feels better than the current Ink composer path before committing to any rewrite.

Scope:

- Keep the existing Node/Ink TUI untouched.
- Build an isolated `pi-tui` prototype with a mycli-like header, transcript, status line, and editor.
- Use fake local transcript/tool/assistant events only; do not connect Python runtime or gateway.
- Use pi-tui's `TUI`, `ProcessTerminal`, `Editor`, and autocomplete support.

Completed:

- Added `pi-tui/examples/mycli-simple.ts` as a runnable mycli-style prototype.
- Added `pi-tui/test/mycli-simple.test.ts` for the pure render/command model.
- Added `npm run mycli:simple` and `npm run test:mycli` scripts in `pi-tui/package.json`.
- Installed pi-tui-local dependencies with a worktree-local npm cache so the prototype can run independently.

Run:

```bash
cd pi-tui
npm run mycli:simple
```

Verify:

```bash
cd pi-tui
npm run test:mycli
```

Remaining follow-up risk:

- This is a spike, not a production TUI path.
- It does not yet support trust, approvals, runtime events, Python gateway calls, or session resume.
- If the prototype feels good, the next decision is whether to migrate only the composer/editor behavior into Ink or build a second full pi-tui frontend.

## Batch P3.1 - pi-tui Real Gateway Experiment

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: prove the pi-tui frontend can reuse the real Python gateway and existing Node reducer without replacing the current Ink TUI.

Scope:

- Keep the existing Node/Ink TUI untouched.
- Add an experimental `pi-tui` entry that uses `GatewayClient` over process `stdin/stdout`.
- Render UI through `/dev/tty` so JSON-RPC pipes remain reserved for the Python gateway.
- Reuse `ShellState`, `reduceShellState`, local slash command handling, and session command routing from `tui/node`.
- Keep reasoning collapsed by default and avoid mixing reasoning text into final assistant output.

Completed:

- Added `pi-tui/examples/mycli-gateway.ts` as a real-gateway pi-tui experiment.
- Added `TtyTerminal` for `/dev/tty` rendering while preserving process stdio for gateway JSON-RPC.
- Added projection helpers for header, transcript, footer, gateway events, and reducer actions.
- Added basic submit, local slash command, runtime command, session list/resume, interrupt, shutdown, and queued prompt handling.
- Added `pi-tui/test/mycli-gateway.test.ts` covering gateway event projection, local reducer behavior, and tty/stdout isolation.
- Added `npm run mycli:gateway` and extended `npm run test:mycli`.
- Added `MYCLI_TUI_BACKEND=pi` routing through the existing Python node gateway process.

Run:

```bash
cd pi-tui
npm run mycli:gateway
```

Run through mycli:

```bash
cd /path/to/mycli
MYCLI_TUI_BACKEND=pi uv run mycli
```

Verify:

```bash
cd pi-tui
npm run test:mycli
../tui/node/node_modules/.bin/tsc --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --strict --skipLibCheck --typeRoots ../tui/node/node_modules/@types --types node examples/mycli-simple.ts examples/mycli-gateway.ts test/mycli-simple.test.ts test/mycli-gateway.test.ts
cd ..
uv run pytest -q tests/unit/cli/node_tui/test_process.py
```

Remaining follow-up risk:

- Trust prompt, approval selection, clarification selection, scrollback, and overlay focus are rendered through shared state but not yet productized as pi-tui-native interactions.
- The `/dev/tty` terminal adapter is intentionally minimal; full keyboard protocol negotiation, alternate-screen policy, suspend/resume, and crash cleanup need a deeper pass before promotion.

## Batch P4 - pi-agent Style Component Shell

Status: completed in `feature/mycli-termcn-tui-polish`.

Goal: replace the experimental pi-tui line renderer with a component-based coding-agent UI shell inspired by `coding-agent`, while keeping Python runtime and the existing gateway as the source of truth.

Reference:

- `docs/parity/pi-agent-tui-lessons.md`
- `coding-agent/src/modes/interactive/components/user-message.ts`
- `coding-agent/src/modes/interactive/components/assistant-message.ts`
- `coding-agent/src/modes/interactive/components/tool-execution.ts`
- `coding-agent/src/modes/interactive/components/bash-execution.ts`
- `coding-agent/src/modes/interactive/components/footer.ts`

Scope:

- Keep `ShellState` and `reduceShellState` as the state source.
- Introduce a pi-tui transcript block model instead of rendering transcript rows directly to strings.
- Add component classes for user, assistant, reasoning, system/error, generic tool, bash, and footer.
- Render assistant final answers as Markdown.
- Keep reasoning collapsed by default and show metadata only.
- Keep routine read/search tools hidden in default view unless verbose.
- Keep failed tools, shell commands, and file mutations visible.
- Keep all lines width-safe.

Planned components:

- `UserMessageBlock`
- `AssistantMessageBlock`
- `ReasoningBlock`
- `SystemNoticeBlock`
- `ToolExecutionBlock`
- `BashExecutionBlock`
- `FooterComponent`

Acceptance markers:

- `mycli-gateway.ts` no longer owns transcript formatting logic directly.
- Final assistant answer is visually dominant and Markdown-rendered.
- Reasoning text never appears in header/footer/final answer.
- Tool rendering has running/success/error visual states.
- Bash output has command, status, preview, and truncation behavior.
- Footer shows cwd/session/model/trust/context/queue/live state in a width-safe way.
- Focused tests cover each component's rendered output and width behavior.

Remaining follow-up risk:

- Selector overlays are deferred to P5 unless needed for trust/approval during P4.
- Full scrollback/paging can wait until block rendering is stable.

Completed:

- Added `pi-tui/examples/mycli-shell-components.ts` as the pi-tui shell/component layer.
- `mycli-gateway.ts` now delegates header, transcript, footer, and transcript block rendering instead of owning transcript row formatting directly.
- Added `ShellState -> TranscriptBlock[] -> Component` projection through `projectTranscriptBlocks`.
- Added component renderers for user messages, assistant messages, reasoning, system notices, generic tool execution, bash execution, and footer rendering.
- Assistant final/stream text now renders through pi-tui Markdown rendering.
- Reasoning blocks render metadata-only hidden labels and do not expose raw reasoning text.
- Routine successful `Read`/`Grep` tools are hidden outside verbose mode, while failed/mutating/shell tools remain visible.
- Failed tool rendering uses bounded structured preview fields and keeps raw stdout/stderr hidden by default.
- Bash has a dedicated row with command, status, duration/exit detail, bounded preview, and detail hint.
- Footer renders cwd, session, model/provider, trust, context, queue, live state, and pending markers according to local statusbar mode.
- Tests cover projection, reasoning non-leakage, routine tool hiding, verbose visibility, command output rendering, and line width safety.

## Batch P5 - Command Registry And Selector Surfaces

Status: completed for the registry/foundation pass in `feature/mycli-termcn-tui-polish`.

Goal: make slash commands a product surface instead of scattered local/runtime handlers.

Reference:

- `docs/parity/pi-agent-tui-lessons.md`
- `coding-agent` command categories from README and interactive mode.

Scope:

- Extract pi-tui command handling out of `mycli-gateway.ts`.
- Define one command registry for local, runtime, reserved, and future extension/plugin commands.
- Generate slash completion, `/help`, `/commands`, and `/hotkeys` from that registry.
- Support command result presentation kinds: transcript, overlay, selector, and mutation confirmation.
- Convert high-value flows to selectors where data is available.

Command categories to track:

- Session: `/sessions`, `/resume`, `/new`, `/title`, `/fork`, `/tree`
- Model/settings: `/model`, `/provider`, `/settings`, `/theme`
- Context/runtime: `/context`, `/usage`, `/compact`, `/retry`
- Safety: `/trust`, approvals, `/doctor`, `/terminal-setup`
- Files/changes: `/changes`, `/diff`, `/undo`, `/checkpoint`
- View: `/view`, `/details`, `/statusbar`, `/hotkeys`
- Utility: `/copy`, `/export`, `/clear`, `/quit`

Acceptance markers:

- `/help`, autocomplete, and footer/hotkey hints use the same registry.
- Local UI commands never call Python runtime.
- Runtime commands remain routed through typed RPC or `command.run`.
- Unknown commands show nearest matches.
- Mutating commands echo effective state.
- `/sessions`, `/resume`, `/model`, trust, approval, and clarification are ready to become selector components.

Remaining follow-up risk:

- Extension/plugin command registration should wait until the local registry is stable.
- Session tree/fork/clone commands need Python runtime support before becoming real selectors.

Completed:

- Added `pi-tui/examples/mycli-command-registry.ts` as the pi-tui command registry and dispatch surface.
- `mycli-gateway.ts` now delegates local command handling, runtime command submission, and unknown command handling to the registry module.
- One registry now drives pi-tui slash completion, `/help`, `/commands`, `/hotkeys`, local/runtime/reserved routing, and unknown-command suggestions.
- Existing local commands remain local: `/help`, `/?`, `/theme`, `/clear`, `/history`, `/search`, `/export`, `/copy`, `/view`, `/details`, `/statusbar`, `/terminal-setup`, and `/queue`.
- Existing runtime commands continue through typed RPC or `command.run`: `/status`, `/context`, `/usage`, `/changes`, `/undo`, `/sessions`, and `/resume`.
- Planned/reserved command entries are now represented for `/model`, `/provider`, `/settings`, `/compact`, `/retry`, `/title`, `/diff`, `/checkpoint`, `/trust`, `/doctor`, `/new`, `/fork`, and `/tree`.
- `/commands` and `/hotkeys` are local pi-tui overlays generated from the registry/hotkey model.
- Unknown slash commands render a bounded overlay with nearest matches instead of falling through silently.
- Tests cover local/runtime/unknown routing, registry output, help/hotkey content, and command visibility.

## Do Not Prioritize Yet

- Forking Ink or copying Hermes renderer internals.
- Full custom ScrollBox.
- Browser, voice, replay, perf pane, and fun commands.
- Big banner art or decorative UI.

## Execution Rule

Work one batch at a time. Each batch must:

- Preserve Python runtime as source of truth.
- Keep Node UI changes bounded to typed events/state.
- Add focused tests for the user-visible behavior.
- Run the verification commands listed in P0.1 before claiming completion.

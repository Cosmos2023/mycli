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
- `/redraw` and `/terminal-setup` are discoverable reserved runtime fallbacks; Node does not fake terminal diagnostics.
- `/statusbar` and `/details` remain reserved runtime fallbacks from P1.1 and are discoverable through catalog/help.

Remaining follow-up risk:

- `/history`, `/search`, `/export`, and `/copy` are local visible-transcript conveniences; durable historical search/export still needs runtime-backed storage APIs if older unloaded history should be included.
- Clipboard integration is intentionally not implemented in Node yet; `/copy` is a manual copy preview to avoid hidden side effects.
- Mouse wheel support and subagent dashboard remain deferred until keyboard flow and delegation state contracts are more mature.

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

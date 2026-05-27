# Node TUI Shell

## 1. Background

`node-tui-gateway` proved the Python runtime can launch a Node subprocess, exchange line-delimited JSON-RPC over process pipes, forward streaming turn events, run Python-owned slash commands, and complete a real provider-backed smoke. The next step is to replace the current Python Textual TUI with a daily-usable Node terminal UI while keeping the same ownership boundary:

- Python owns agent runtime, model calls, tools, prompts, sessions, compaction, memory, approvals, usage, and slash-command behavior.
- Node owns terminal rendering, keybindings, input editing, scroll state, completion popups, overlays, folded transcript state, and view preferences.

This spec defines the `node-tui-shell` slice. It is not a second protocol smoke. It targets a usable Claude Code-like shell that can become the default interactive `mycli` entrypoint.

## 2. Goals

### 2.1 Make Node TUI the default interactive shell

Interactive `mycli` should launch the Node TUI by default when the terminal and Node runtime support it.

Required routing:

- `mycli` in an interactive terminal: launch Node TUI.
- `mycli --node-tui`: force Node TUI.
- `MYCLI_TUI_BACKEND=node mycli`: force Node TUI.
- `mycli --plain`: always use the plain Python REPL.
- Non-interactive stdin/stdout: keep plain behavior.
- Existing evaluation and scripted flags: keep current behavior.

Fallback behavior:

- If Node is missing or below the supported version, print a concise error with `--plain` guidance.
- If Node TUI startup fails before the first runtime handshake, fall back to the existing Python TUI only when `MYCLI_TUI_FALLBACK=textual` or `tui_fallback = "textual"` is configured.
- If `MYCLI_TUI_FALLBACK=plain` or `tui_fallback = "plain"` is configured, use the plain Python REPL instead of the Python Textual TUI after Node startup failure.
- Runtime or model errors after the shell is running are rendered inside the Node TUI, not hidden by falling back.

Without an explicit fallback setting, startup failure exits with guidance rather than silently switching UI backends.

### 2.2 Use Ink/React for the full-screen shell

Use a Node React terminal UI stack, centered on Ink.

Required properties:

- Componentized transcript, input, status line, completion popup, overlays, and approval prompts.
- Full-screen terminal behavior with controlled keyboard handling.
- Incremental rendering from reducer state, not full transcript rewrites per token.
- Testable non-visual reducers and protocol adapters.
- Snapshot coverage for transcript, input, completion popup, overlay, and approval prompt states.

The existing `tui/node` smoke client can remain as a test fixture, but the production Node entrypoint should become an Ink app.

### 2.3 Preserve Python runtime authority

Node must not:

- read or write session databases
- execute tools
- construct model-visible prompts
- mutate memory or compaction state
- implement provider calls
- implement slash-command business logic

Node may keep ephemeral UI state:

- current input draft
- previous draft restored after interrupt
- selected completion row
- scroll position
- overlay visibility
- folded or expanded transcript item ids
- current view mode: `default`, `verbose`, or `focus`

### 2.4 Render a daily-usable transcript

The transcript should be conversation-first and close to Claude Code's interaction model.

Normal rendering rules:

- Do not show large role cards labeled `USER`, `ASSISTANT`, `TOOL`, or `REASONING`.
- Use subtle prompt markers, indentation, spacing, and folded blocks.
- Show user submissions immediately.
- Show one live execution row while a turn is running.
- Stream final assistant text into one assistant block.
- On `turn.completed`, replace or reconcile the streamed assistant block with `assistant_message`, treating the final payload as authoritative.
- Do not duplicate streamed text and final text when they are equivalent.
- Preserve enough internal typed state for deterministic tests and non-visual rendering metadata.

Required transcript item types:

```text
user
assistant_stream
assistant_final
execution_status
tool_summary
tool_detail
command_output
warning
error
approval
system_notice
```

### 2.5 Show tool calls and results correctly

Tool activity must be visible in the transcript, but not noisy by default.

Default view:

- Show concise one-line summaries such as `Read pyproject.toml`, `Edit src/...`, `Bash pytest -q`.
- Fold long tool results, command output, diffs, and logs.
- Keep a rolling execution path while the turn is running:

```text
Thinking... (12s)
Reading files... (19s)
Running tests... (37s)
Editing files... (44s)
```

Verbose view:

- `/view verbose` expands tool call details, tool arguments when safe, stdout/stderr previews, and model stream phases.
- Secrets or sensitive values must remain redacted if Python already redacts them.
- Node must not invent redaction policy; it only respects fields provided by Python.

Focus view:

- `/view focus` emphasizes the final answer and hides non-error tool detail unless expanded manually.

The default mode is `default`. The `/view` command continues to be Python-owned, but Node may mirror the selected mode into local UI state when `command.run` returns a view change or command output.

### 2.6 Support slash and path completion

Completion behavior must fix the current Textual rough edges.

Slash completion:

- Typing `/` opens suggestions without submitting `/`.
- Suggestions filter as the user types.
- Up/down arrows move selection and keep the selected row visible.
- `Tab` inserts the selected command and must not move terminal focus.
- `Enter` with an active suggestion accepts the suggestion first when the input is only an incomplete command prefix.
- `Enter` on a complete command executes it.
- `Esc` closes suggestions without modifying input.

Path completion:

- `@path` suggestions call `completion.path`.
- Candidates remain workspace-local.
- Up/down/Tab/Enter/Esc behavior mirrors slash completion.

Node renders completion UI; Python remains the source of truth for candidates.

### 2.7 Support overlays and command output

Use overlays for inspection commands and compact transcript rows for simple command output.

First-slice overlays:

- `/help`
- `/status`
- `/usage`
- `/context`
- `/sessions`
- `/release-notes`

Overlay rules:

- `Esc` closes the overlay.
- Overlays do not enter model-visible history.
- Overlay content comes from Python `command.run`, `status.inspect`, or `session.list`.
- Command output that changes session state should also emit `session.changed` or `status.changed` from Python.

Simple commands:

- `/quit` exits cleanly through `shutdown`.
- `/clear` clears the visible Node transcript only; it must not delete Python session history.
- `/view default`, `/view verbose`, and `/view focus` update the Node transcript view while preserving Python command semantics.

### 2.8 Implement interrupt and approval UI

Interrupt behavior:

- `Ctrl+C` before submit clears or restores the current edit state.
- `Ctrl+C` while a turn is running sends `turn.interrupt`.
- The pre-submit draft is restored after interruption so the user can edit and resend.
- Partial assistant output from an interrupted turn is marked as interrupted and must not be treated as a completed final answer.

Approval behavior:

- Python emits `approval.pending`.
- Node renders a focused approval prompt with allowed choices.
- Node sends `decision.resolve`.
- Python remains responsible for applying the decision and resuming or stopping the turn.

If `decision.resolve` is incomplete in the gateway, this slice must add it before the approval UI is considered complete.

### 2.9 Show accurate status and usage

Persistent bottom status:

- left: workspace name/path and session id when useful
- right: model and context window usage

Example:

```text
mycli  ./repo                                      deepseek-v4  context 3,983 / 100,000
```

Status updates:

- `runtime.ready` initializes status.
- `status.changed` refreshes context usage, pending decision state, suspended turn state, and model/provider display.
- `/usage` and `/context` overlays show the detailed Python-provided values.

Node must not calculate context-window usage from transcript text. It displays Python-provided metrics.

### 2.10 Restore the startup welcome screen

The Node TUI should preserve the P6 welcome experience, but render it as Node UI state rather than Python Textual markup.

Required welcome content:

- `mycli` version.
- Current session id.
- Workspace path.
- Current model and provider/protocol.
- Context window usage when known.
- Startup mark name and terminal-safe ASCII mark.
- Tips such as `/help`, `/context`, `/usage`, and `/sessions`.
- Release-notes hint when Python exposes one.

Data source:

- `session.bootstrap` returns a `welcome` object with the fields above.
- Node renders the welcome as a non-history transcript item of type `system_notice`.
- The welcome is not appended to Python session history and never becomes model-visible context.

Startup marks:

- Default mark remains neutral `mycli`.
- Optional configured marks, including zodiac marks, are resolved by Python and returned as ASCII text.
- Node does not duplicate mark selection logic.

## 3. Non-goals

`node-tui-shell` does not:

- change model-visible request shape
- change compaction or rehydration behavior
- change provider protocols
- change tool safety or approval policy
- implement a model picker
- implement interactive diff editing
- implement a session database migration
- replace Python slash-command implementations with Node copies
- add multi-pane IDE-like layouts
- implement hard process-level cancellation of provider calls

## 4. Architecture

### 4.1 Process and IO model

Python remains the parent process.

```text
Python mycli process
  ├─ TurnService / AgentRuntime / SessionService / ToolExecutionService
  ├─ NodeTuiGateway
  └─ launches Node child

Node child
  ├─ JSON-RPC client over inherited stdin/stdout pipes
  ├─ Ink/React app over controlling TTY streams
  └─ UI reducer + components
```

The full-screen UI cannot share stdout with JSON-RPC. The Node app must open the controlling TTY for Ink rendering and keyboard input while keeping process stdin/stdout reserved for RPC.

Implementation requirements:

- Keep one line-delimited JSON object per RPC message.
- Keep terminal escape sequences out of RPC payloads.
- Ensure Node can close TTY and RPC readers on shutdown.
- Ensure Python waits for a clean child exit on `shutdown`.
- Provide a clear unsupported-terminal error when no controlling TTY is available.

### 4.2 Node package structure

Target structure:

```text
tui/node/
  package.json
  src/
    index.tsx
    app/
      App.tsx
      Transcript.tsx
      InputBox.tsx
      CompletionPopup.tsx
      StatusLine.tsx
      Overlay.tsx
      ApprovalPrompt.tsx
    protocol/
      client.ts
      types.ts
    state/
      reducer.ts
      events.ts
      transcript.ts
      completion.ts
      viewMode.ts
    terminal/
      tty.ts
      keymap.ts
    smoke/
      scriptedClient.ts
  test/
    reducer.test.ts
    completion.test.ts
    protocol.test.ts
    scripted-client.test.ts
```

The implementation may retain JavaScript for the existing smoke files during transition, but the production Ink shell should use TypeScript because protocol payloads and reducer state are now part of the UI contract.

### 4.3 Python gateway extensions

The existing gateway already supports:

- `session.bootstrap`
- `turn.submit`
- `turn.interrupt`
- `command.run`
- `completion.slash`
- `completion.path`
- `status.inspect`
- `session.list`
- `session.resume`
- `shutdown`

This slice should extend or harden the gateway for the full shell:

- `decision.resolve` for approval prompts.
- `transcript.load` so Node can render existing session history after launch or resume.
- Structured command output metadata so Node can decide overlay vs transcript row from explicit fields; legacy plain-text command lines render as `command_output`.
- View-mode command metadata for `/view`.
- Stable event ids for transcript items that can be folded or expanded.
- More complete tool event payloads when Python already has safe summaries available.

Any new protocol method must be covered by Python protocol/gateway tests and Node protocol tests.

### 4.4 Protocol extensions

The following shapes extend the gateway contract for the full shell.

#### `session.bootstrap`

Request:

```json
{
  "method": "session.bootstrap",
  "params": {
    "protocol_version": 1,
    "client": { "name": "mycli-node-tui", "version": "0.2.0" }
  }
}
```

Result:

```json
{
  "protocol_version": 1,
  "session_id": "default",
  "workspace": "/repo",
  "model": "deepseek-v4",
  "provider": "deepseek/chat_completions",
  "status": {},
  "welcome": {
    "version": "0.1.0",
    "session_id": "default",
    "workspace": "/repo",
    "model": "deepseek-v4",
    "provider": "deepseek/chat_completions",
    "context_window": { "used_tokens": 3983, "max_tokens": 100000, "source": "provider" },
    "startup_mark": { "name": "default", "text": "mycli" },
    "tips": ["/help", "/context", "/usage", "/sessions"],
    "release_notes_hint": "Run /release-notes"
  }
}
```

`session.bootstrap` returns welcome and status data. Historical transcript content is loaded through `transcript.load`.

#### `transcript.load`

Request:

```json
{
  "method": "transcript.load",
  "params": {
    "session_id": "default",
    "limit": 200,
    "before": null
  }
}
```

Result:

```json
{
  "session_id": "default",
  "items": [
    {
      "id": "hist_42",
      "type": "user",
      "text": "Read pyproject.toml",
      "created_at": "2026-05-27T08:00:00Z",
      "folded": false,
      "metadata": {}
    },
    {
      "id": "hist_43",
      "type": "assistant_final",
      "text": "The project is mycli.",
      "created_at": "2026-05-27T08:00:01Z",
      "folded": false,
      "metadata": {}
    }
  ],
  "next_before": "hist_42"
}
```

Rules:

- Items are UI transcript projections derived from Python-owned session history.
- `transcript.load` does not mutate session state.
- Node may use `next_before` for older-history pagination.
- Tool detail bodies may be omitted or folded when Python does not have safe detail text.

#### `decision.resolve`

Python emits `approval.pending` before Node can resolve a decision.

Notification:

```json
{
  "method": "approval.pending",
  "params": {
    "decision_id": "decision_current",
    "tool_name": "Bash",
    "reason": "git push requires confirmation.",
    "preview": "git push origin main",
    "options": [
      { "choice": "approve_once", "label": "Allow once" },
      { "choice": "reject", "label": "Reject" },
      { "choice": "allow_session", "label": "Allow similar commands this session" }
    ]
  }
}
```

Request:

```json
{
  "method": "decision.resolve",
  "params": {
    "decision_id": "decision_current",
    "choice": "approve_once"
  }
}
```

Immediate result:

```json
{
  "accepted": true,
  "decision_id": "decision_current",
  "client_turn_id": "approval_1"
}
```

Rules:

- Gateway maps `approve_once`, `reject`, and `allow_session` to the current Python approval choices.
- Resolving a decision resumes work through the same event channel as a normal turn: `turn.started`, zero or more `turn.event`, then `turn.completed` or `turn.failed`.
- If the decision id is stale or no pending decision exists, return a JSON-RPC error with code `decision_not_pending`.
- Rejection may complete immediately with a final assistant/system notice; it still clears the pending decision in Python.

#### `command.run`

The existing result shape is extended from plain lines to structured command metadata.

Request:

```json
{
  "method": "command.run",
  "params": { "command": "/view verbose" }
}
```

Result:

```json
{
  "lines": ["[view] mode=verbose"],
  "mutated_session": false,
  "presentation": "transcript",
  "view_mode": "verbose",
  "exit_requested": false
}
```

Rules:

- `presentation` is one of `transcript`, `overlay`, or `none`.
- `/help`, `/status`, `/usage`, `/context`, `/sessions`, and `/release-notes` return `presentation: "overlay"`.
- `/view default`, `/view verbose`, and `/view focus` return `view_mode`.
- `/quit` returns `exit_requested: true`; Node then sends `shutdown`.
- Legacy command handlers that only return lines are wrapped as `presentation: "transcript"`.

### 4.5 State flow

Turn flow:

```text
User enters message
  → Node app appends user transcript item
  → Node sends turn.submit
  → Python emits turn.started
  → Python emits turn.event events incrementally
  → Node reducer updates execution row, tool summaries, and assistant stream
  → Python emits turn.completed
  → Node reducer finalizes assistant answer and status
```

Command flow:

```text
User enters slash command
  → Node sends command.run unless command is purely local UI state
  → Python executes command behavior
  → Node renders result as overlay, transcript row, session change, or shutdown
```

Completion flow:

```text
Input draft changes
  → Node debounce/calls completion.slash or completion.path
  → Python returns candidates
  → Node updates popup selection state
```

Completion requests should be cancellable or sequence-numbered so stale responses cannot overwrite newer suggestions.

## 5. Rendering Requirements

### 5.1 Layout

Use a single conversation column.

```text
┌ transcript scroll region ┐
│ welcome / history        │
│ user message             │
│ execution status         │
│ tool summaries           │
│ assistant stream/final   │
└──────────────────────────┘
  completion popup
  input box
  bottom status
```

No permanent right sidebar. No dense top dashboard. Use overlays for temporary details.

### 5.2 Streaming performance

The reducer must update only affected state:

- Append text deltas into the current assistant stream item.
- Throttle rendering if needed, but do not batch so aggressively that final answer feels delayed.
- Never rebuild the full transcript for each token.
- Preserve scroll position when the user is reading history.
- Auto-scroll only when the user is already at the bottom or the current turn belongs to them.

### 5.3 Markdown

Assistant output should support:

- paragraphs
- lists
- inline code
- fenced code blocks
- markdown tables rendered as aligned plain terminal text when the parser recognizes them; otherwise preserve the source table text
- links as plain terminal text

Markdown parsing happens in Node, but final answer content comes from Python.

Streaming strategy:

- During `text_delta`, render the active assistant item through a lightweight `StreamingText` component that appends plain text to the current item state.
- Do not re-parse completed transcript items when a new delta arrives.
- Keep stable React keys for every transcript item so completed user messages, tool summaries, and assistant finals are not remounted during streaming.
- Use `React.memo` around transcript rows whose props did not change.
- Parse Markdown for the active assistant item on a throttled cadence, or render plain text while streaming and parse once when the answer is finalized.
- On `turn.completed`, replace the active stream item with the authoritative `assistant_message` through `React.startTransition` when available; this is the only required full Markdown parse for that answer.

This avoids the Textual full-redraw failure mode without requiring Markdown AST-level incremental parsing in the first Node shell.

## 6. Error Handling

Startup errors:

- Missing Node or unsupported version: concise terminal error with `mycli --plain` guidance.
- Missing TTY: concise terminal error with fallback guidance.
- Protocol version mismatch: fail fast before rendering shell.

Runtime errors:

- JSON-RPC parse errors render as non-model-visible gateway errors.
- `turn.failed` renders as an error transcript item.
- Lost Python connection exits Node with a clear message.
- Lost Node child causes Python to exit the TUI path cleanly without corrupting session state.

Shutdown:

- `/quit` sends `command.run`, then `shutdown`.
- `Ctrl+D` exits when no turn is running.
- Active turns request interruption before shutdown and show a confirmation prompt if the provider/tool call is still running.

## 7. Testing And Verification

Required tests:

- Node reducer tests for turn lifecycle, streaming final answer, tool folding, command output, view modes, stale completion responses, and interrupt markers.
- Node component or snapshot tests for transcript, input, completion popup, status line, overlays, and approval prompt.
- Node protocol tests for all gateway requests and notifications used by the shell, including `transcript.load`, `decision.resolve`, `command.run.view_mode`, and `session.bootstrap.welcome`.
- Python gateway tests for new methods and event payloads, including stale decision rejection and transcript-load pagination.
- CLI routing tests proving interactive default selects Node and `--plain` overrides it.
- Integration test with fake Python gateway and real Node shell entrypoint.
- Real smoke:

```text
mycli
  → default launches Node TUI in an interactive terminal
  → submit a prompt that uses Read
  → observe streamed assistant answer
  → observe folded tool summary
  → run /view verbose
  → run /usage
  → run /sessions
  → run /quit
```

Required verification commands should include:

```bash
npm --prefix tui/node test
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

The implementation report must include the real smoke transcript summary and confirm stdout remains protocol-only.

## 8. Migration Plan

Recommended implementation slices:

1. Add TypeScript/Ink shell scaffolding and TTY adapter while keeping the scripted smoke client available.
2. Build protocol client and reducer around existing gateway events.
3. Implement transcript, status line, input box, and basic turn submission.
4. Add slash/path completion with keyboard behavior.
5. Add tool folding, view modes, overlays, and approval prompt.
6. Add `transcript.load` and resume-history rendering support.
7. Switch interactive default routing to Node TUI with `--plain` override and fallback errors.
8. Run full verification and real smoke.

Do not remove the Python Textual TUI in this slice. Keep it as a temporary fallback until Node TUI has passed multiple real-use sessions.

## 9. Acceptance Criteria

- Interactive `mycli` launches the Node Ink TUI by default.
- `mycli --plain` keeps plain behavior.
- Python remains the only runtime/session/model/tool authority.
- Node opens a terminal stream for UI without polluting JSON-RPC stdout.
- User messages, execution progress, tool summaries, streamed final answer, and final assistant answer render in order.
- Tool details are folded by default and visible in verbose mode.
- Slash completion does not submit bare `/`.
- Arrow-key selection scrolls the suggestion window.
- `Tab` accepts suggestions without moving focus away from input.
- `/help`, `/status`, `/usage`, `/context`, `/sessions`, `/release-notes`, `/view`, `/clear`, and `/quit` work.
- `Ctrl+C` interrupts a running turn through the gateway and restores the draft.
- A real provider-backed smoke completes with no pending decision or suspended turn left behind.
- Full Python and Node verification suites pass.

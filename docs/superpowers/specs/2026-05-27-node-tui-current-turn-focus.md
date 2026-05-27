# Node TUI Current Turn Focus

## 1. Background

The `node-tui-visual-structure-v2` slice improved individual rows, but real terminal use still looks like a plain log. A representative screenshot shows repeated full answers, weak separation between turns, tool/activity rows appearing after answer content, and too much historical text competing with the current task.

This slice moves the Node TUI toward a Claude-Code-like console structure:

- compact header
- current turn as the main visual object
- previous turns collapsed by default
- tool activity displayed before the final assistant answer
- stable bottom command bar

Python remains the only runtime authority. The Node process only changes display grouping and rendering.

## 2. Goals

### 2.1 Make the Current Turn the Primary View

The default screen should treat the terminal as a viewport, not an infinite transcript dump. The current or most recent turn should occupy the readable area. Older turns should be summarized into compact one-line rows unless the user explicitly asks for more detail through an existing view mode.

Required default shape:

```text
mycli  workspace                  session           model · context
────────────────────────────────────────────────────────────────────

Earlier turns collapsed · 3 turns · /view verbose for full transcript

› 你的系统提示词是什么
  read   AGENTS.md                         done 18ms
  grep   system prompt                     4 matches

  我的系统提示词是当前对话开头设置的完整指令集，核心包括：
  • 身份定位：mycli，本地优先的个人编程助手
  • 核心准则：持续推进、证据优先、安全可回退

────────────────────────────────────────────────────────────────────
› Type a message or /command                         graphite · 9%
```

### 2.2 Show Tool Activity Before the Final Answer

Within each turn, display order must be:

1. user prompt
2. approval, tool, and execution status rows
3. running activity row while the turn is in progress
4. assistant stream/final answer
5. command or system notices that are local to the UI, when applicable

Tool calls must not visually trail the final assistant answer in default mode. If transcript events arrive in a different order, rendering should derive a display model that places tool telemetry before the assistant block without mutating the stored transcript.

### 2.3 Stay Claude-Code-Like, Not Dashboard-Like

Use restrained terminal structure:

- no large `USER` / `ASSISTANT` role cards
- no permanent sidebar
- no decorative panels around every answer
- no mouse-first interaction
- no full-screen dashboard
- no model-visible UI-only text

The screen should feel like a focused coding console: dense, readable, and easy to scan.

### 2.4 Keep Node Disposable

Allowed Node-only state:

- display-only turn grouping
- collapsed/expanded rendering decisions
- derived current-turn focus
- display ordering inside a turn
- UI-only notices for `/theme` and `/clear`

Disallowed Node ownership:

- session persistence
- model-visible transcript content
- tool execution state of record
- approval policy
- slash-command business logic beyond existing local UI commands
- compaction, memory, provider, prompt, or Python gateway behavior

## 3. Non-Goals

- No Python gateway protocol changes.
- No persisted transcript migration.
- No custom scrollback engine.
- No search UI.
- No side panel.
- No new dependency.
- No changes to model prompts, tools, approvals, sessions, or compaction.
- No deletion of Python/Textual fallback.

## 4. Display Model

### 4.1 Turn Grouping

The reducer can keep the existing flat `state.transcript`. Rendering should derive a display model:

```ts
type DisplayTurn = {
  id: string;
  user: TranscriptItem | null;
  tools: TranscriptItem[];
  statuses: TranscriptItem[];
  approvals: TranscriptItem[];
  assistantStream: TranscriptItem | null;
  assistantFinal: TranscriptItem | null;
  notices: TranscriptItem[];
  errors: TranscriptItem[];
};
```

First implementation rule:

- start a new `DisplayTurn` at every `TranscriptItem` with `type === "user"`
- attach following items to that turn until the next user item
- attach bootstrap/welcome notices to a prelude bucket
- if the transcript has no user item, show existing welcome behavior

This is intentionally display-only. Do not add `turn_id` to protocol payloads unless a future bug proves user-boundary grouping is insufficient.

### 4.2 Current Turn Selection

Default view mode should render:

- prelude/welcome only if there is no conversation content
- a compact collapsed-history row when there are older turns
- the current turn expanded
- local command notices only when they are recent and relevant

The current turn is:

- the last turn when no turn is running
- the turn containing the submitted user prompt while `state.turnRunning` is true

Older turns are represented as a single summary line:

```text
Earlier turns collapsed · 3 turns · /view verbose for full transcript
```

Do not render every old assistant answer in default mode.

### 4.3 View Modes

Use existing `ViewMode` values:

- `default`: current turn focused, older turns collapsed
- `verbose`: full transcript, preserving existing row detail
- `focus`: only current turn and running activity, hiding history summary if needed

Do not add a new slash command in this slice. Continue using existing `/view` behavior.

## 5. Turn Layout

### 5.1 User Prompt

Required shape:

```text
› 你的系统提示词是什么
```

Rules:

- no role label
- accent marker from theme
- wrap inside the same content width as the assistant answer
- leave a small visual gap before tool rows

### 5.2 Tool Timeline

Tool/activity rows are placed immediately after the user prompt and before assistant text.

Required shape:

```text
  read   AGENTS.md                         done 18ms
  grep   system prompt                     4 matches
  bash   pytest -q                         exit 0
```

Rules:

- use existing `formatToolSummary()` for verb/target/status/detail
- align columns when enough width exists
- use compact single-line fallback on narrow widths
- running status uses warning/accent color
- failed status uses error color
- default mode shows summaries only
- verbose mode may show tool details under the summary

### 5.3 Running Activity

While a turn is running, show a live activity row before the assistant stream:

```text
  thinking 12s · read → grep → bash
```

Rules:

- derive recent path from tool summary rows
- keep it inside the active turn, not as a detached global footer
- hide it after `turn.completed`
- do not block input or interrupt handling

### 5.4 Assistant Answer

Assistant text appears after tools/activity.

Required shape:

```text
  我的系统提示词是当前对话开头设置的完整指令集，核心包括：
  • 身份定位：mycli，本地优先的个人编程助手
```

Rules:

- no `ASSISTANT` label
- no permanent left rail if it makes the screen look like raw logs
- use indentation and bounded width for hierarchy
- streaming answer is plain text
- final answer may use existing markdown renderer
- final markdown replaces the stream without duplication

## 6. Header And Bottom Bar

The existing compact header and bottom command bar stay, but they must not dominate the screen.

Header priority at 80 columns:

1. `mycli`
2. workspace basename
3. session id, elided
4. model name, elided
5. context usage

Bottom bar priority:

1. prompt marker and placeholder/draft
2. active command hint
3. compact metadata, elided from the left if needed

No header or bottom bar content should wrap into a broken second line at normal 80-column width.

## 7. Error Handling

- If display grouping receives transcript items before any user item, render them in the prelude bucket using existing row components.
- If a turn contains multiple assistant items due to partial stream/final reconciliation, prefer `assistant_final` and hide stale stream rows.
- If a tool summary cannot be parsed, render the existing fallback summary before the answer.
- If width is unknown, use the existing conservative default width.
- If `/view verbose` is active, preserve access to full details even when default mode collapses history.

## 8. Testing

Required Node tests:

- `groupTranscriptIntoTurns()` starts a new display turn at each user item.
- Default mode collapses older turns and expands only the current turn.
- Tool rows render before assistant final even when the flat transcript order differs.
- Running activity renders inside the active turn before assistant stream.
- Verbose mode still renders full transcript rows.
- Focus mode hides collapsed history and shows only the current turn.
- User/assistant rows do not render `USER` or `ASSISTANT` labels.
- The screenshot-like scenario with four Chinese prompts does not render four full assistant answers in default mode.
- Existing `/theme`, `/usage`, `/sessions`, `/clear`, and `/quit` smoke paths still pass.

Required verification:

```bash
npm --prefix tui/node test
npm --prefix tui/node run typecheck
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Required manual smoke:

```bash
MYCLI_TUI_THEME=graphite uv run mycli --session node-tui-current-turn-focus-smoke
```

Checklist:

1. Ask several short Chinese questions.
2. Confirm older turns collapse in default mode.
3. Confirm current turn remains expanded.
4. Trigger a tool-using prompt and confirm tool rows appear before the final answer.
5. Run `/view verbose` and confirm full transcript access still works.
6. Run `/theme deep-teal`, `/usage`, `/sessions`, `/clear`, and `/quit`.

## 9. Acceptance Criteria

- The default screen no longer looks like a raw transcript log.
- Older assistant answers do not consume the viewport in default mode.
- Tool/activity rows appear before the final assistant answer.
- The current turn is visually dominant.
- Claude-Code-like restraint is preserved: no large role cards or sidebars.
- Node remains a disposable UI process and does not own runtime state.

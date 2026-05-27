# Node TUI Current Turn Focus

## 1. Background

The `node-tui-visual-structure-v2` slice improved individual rows, but real terminal use still looks like a plain log. A representative screenshot shows repeated full answers, weak separation between turns, tool/activity rows appearing after answer content, and too much historical text competing with the current task.

This slice moves the Node TUI toward a Claude-Code-like console structure:

- compact header
- continuous transcript with completed turns still visible
- noisy per-turn internals collapsed by default
- tool activity displayed before the final assistant answer
- stable minimal input row and bottom statusline
- Claude-Code-like visual tokens: `❯` for user turns, `●` for tool calls, `⎿` for expanded tool results, and `▍` for active streaming text

Python remains the only runtime authority. The Node process only changes display grouping and rendering.

## 2. Goals

### 2.1 Keep a Continuous Transcript Without Log Noise

The default screen should remain a continuous Claude-Code-like transcript. Older turns should stay visible with their user prompt and assistant answer, so follow-up questions keep conversational context on screen. What collapses by default is noise inside each turn: raw tool results, repeated read/search groups, and reasoning/thinking detail.

Required default shape:

```text
mycli  workspace
────────────────────────────────────────────────────────────────────

❯ 你是谁
我是 mycli，一个运行在你本地机器上的编程助手。

────────────────────────────────────────────────────────────────────

❯ 你的系统提示词是什么
● Read AGENTS.md
● Search system prompt · 4 matches
● Thinking 12s

我的系统提示词是当前对话开头设置的完整指令集，核心包括：
• 身份定位：mycli，本地优先的个人编程助手
• 核心准则：持续推进、证据优先、安全可回退

────────────────────────────────────────────────────────────────────
>
default · model · theme · context
```

The current turn remains visually active because it is closest to the input and may include running `● Thinking ...` and `▍` stream cursor state. Older completed turns are not replaced by a single "collapsed history" line in default mode.

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
  toolDetails: TranscriptItem[];
  statuses: TranscriptItem[];
  approvals: TranscriptItem[];
  assistantStream: TranscriptItem | null;
  assistantFinal: TranscriptItem | null;
  notices: TranscriptItem[];
  errors: TranscriptItem[];
};
```

The helper should be pure and deterministic:

```ts
type GroupedTranscript = {
  prelude: TranscriptItem[];
  turns: DisplayTurn[];
};

function groupTranscriptIntoTurns(items: TranscriptItem[]): GroupedTranscript;
```

First implementation rule:

- start a new `DisplayTurn` at every `TranscriptItem` with `type === "user"`
- attach following items to that turn until the next user item
- attach bootstrap/welcome notices to a prelude bucket
- attach non-startup command/system notices before the first user to the prelude bucket
- if the transcript has no user item, show existing welcome behavior

This is intentionally display-only. Do not add `turn_id` to protocol payloads unless a future bug proves user-boundary grouping is insufficient.

### 4.2 Default Turn Rendering

Default view mode should render:

- prelude/welcome only if there is no conversation content
- all completed turns in order, including user prompt and assistant answer
- collapsed tool summaries for older turns
- the current turn with live tool/running/stream state
- local command notices only when they are recent and relevant

The current turn is:

- the last turn when no turn is running
- the turn containing the submitted user prompt while `state.turnRunning` is true

Do not replace older turns with a single collapsed-history row in default mode.

### 4.3 View Modes

Use existing `ViewMode` values:

- `default`: continuous transcript, with raw tool results and noisy internals collapsed
- `verbose`: continuous transcript with expanded tool details and subtle turn separators
- `focus`: only current turn and running activity, for users who explicitly want current-turn-only display

Do not add a new slash command in this slice. Continue using existing `/view` behavior.

## 5. Turn Layout

### 5.1 User Prompt

Required shape:

```text
❯ 你的系统提示词是什么
```

Rules:

- no role label
- bright/bold user text
- `❯` user marker in transcript rows, using the active accent color when color is enabled
- wrap inside the same content width as the assistant answer
- leave a small visual gap before tool rows

### 5.2 Tool Timeline

Tool/activity rows are placed immediately after the user prompt and before assistant text.

Required shape:

```text
● Read AGENTS.md
● Search system prompt · 4 matches
● Bash pytest -q · exit 0
```

Rules:

- use existing `formatToolSummary()` for verb/target/status/detail
- render default tool rows as short sentence-like traces, not a table
- keep one tool/action per line
- prefix tool calls with `●`
- render tool call markers and tool names in teal/cyan accent
- avoid trailing tool telemetry after the assistant answer
- running status uses warning/accent color
- failed status uses error color
- default mode shows summaries only
- verbose mode may show tool details under the summary

### 5.3 Tool Result Detail

Expanded tool results should use the Claude-Code-like `⎿` continuation marker.

Default mode:

- show only the `● Tool(args)` style summary line
- hide raw tool output unless the output is the primary answer artifact

Verbose mode:

```text
● Read pyproject.toml
⎿ [project]
  name = "mycli"
  requires-python = ">=3.13"
```

Rules:

- use `⎿` for tool result blocks
- render result content dim/gray
- preserve monospace formatting
- use a subtle gray surface only when Ink can do so without making the UI look boxed
- keep expanded results under the matching tool call, before the assistant answer
- do not add per-tool interactive expansion in this slice
- reserve item-level expand/collapse for a later keyboard navigation slice

### 5.4 Running Activity

While a turn is running, show a live activity row before the assistant stream:

```text
● Thinking 12s · read → grep → bash
```

Rules:

- derive recent path from tool summary rows
- keep it inside the active turn, not as a detached global footer
- hide it after `turn.completed`
- do not block input or interrupt handling

### 5.5 Assistant Answer

Assistant text appears after tools/activity.

Required shape:

```text
我的系统提示词是当前对话开头设置的完整指令集，核心包括：
• 身份定位：mycli，本地优先的个人编程助手
```

Rules:

- no `ASSISTANT` label
- no assistant left rail in default mode
- no bordered answer card in default mode
- use indentation and bounded width for hierarchy
- streaming answer is plain text with a trailing `▍` cursor while active
- final answer may use existing markdown renderer
- final markdown replaces the stream without duplication

### 5.6 Turn Separator

Turn boundaries should be visible without turning the screen into a dashboard.

Rules:

- use a subtle dim horizontal separator between completed turns in default and verbose modes
- omit or reduce separators in focus mode because only one turn is visible
- do not draw heavy borders around each turn

## 6. Header And Bottom Bar

The existing compact header and bottom command bar stay, but they must not dominate the screen.

The header should use one compact row at 80 columns:

```text
mycli  fix-de...hit-rate
────────────────────────────────────────────────────────────────────
```

Header priority:

1. `mycli`
2. workspace basename

Rules:

- put only brand and workspace in the header
- keep runtime metadata out of the header so the current turn remains visually dominant
- elide workspace before wrapping

The bottom area should use two compact rows in default mode:

```text
>
default · deepseek-v4-flash · graphite · 9% 9,302/100k
```

Bottom area priority:

1. prompt marker and current draft
2. runtime metadata below the input: session, model, theme, and context usage

Rules:

- do not render a persistent footer hint bar in default mode
- show shortcut help in `?` / `/help` overlays instead of the main screen
- do not render placeholder text such as `Type a message or /command` in the input row
- keep the input row visually minimal: prompt marker plus the current draft only
- use `>` as the default input prompt, with `❯`, `➤`, `►`, or `»` reserved for future theme/config variants
- put session/model/theme/context below the input box, not in the header
- keep runtime metadata muted
- elide metadata from the left if needed before wrapping
- keep the prompt row visually stronger than metadata

No header or bottom bar content should wrap into a broken second line at normal 80-column width.

## 7. Error Handling

- If display grouping receives transcript items before any user item, render them in the prelude bucket using existing row components.
- If a turn contains multiple assistant items due to partial stream/final reconciliation, prefer `assistant_final` and hide stale stream rows.
- If a tool summary cannot be parsed, render the existing fallback summary before the answer.
- If width is unknown, use the existing conservative default width.
- If `/view verbose` is active, preserve access to full details even when default mode collapses history.

## 8. Testing

Required Node tests:

- `groupTranscriptIntoTurns()` returns `{prelude, turns}` and starts a new display turn at each user item.
- Default mode keeps older user prompts and assistant answers visible.
- Default mode collapses raw tool result details while keeping `●` tool summaries visible.
- Tool rows render before assistant final even when the flat transcript order differs.
- Tool calls use `●` summaries in default mode.
- Verbose mode renders tool details under the matching call with `⎿`.
- Running activity renders inside the active turn before assistant stream.
- Active assistant stream renders a trailing `▍` cursor.
- Verbose mode still renders full transcript rows.
- Focus mode hides prior turns and shows only the current turn.
- User/assistant rows do not render `USER` or `ASSISTANT` labels.
- Default and verbose completed turns have subtle separators.
- The screenshot-like scenario with four Chinese prompts keeps prior prompt/answer context visible without rendering raw tool result blocks.
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
2. Confirm older user prompts and assistant answers remain visible in default mode.
3. Confirm raw tool result details remain collapsed in default mode.
4. Trigger a tool-using prompt and confirm tool rows appear before the final answer.
5. Run `/view verbose` and confirm full transcript access still works.
6. Run `/theme deep-teal`, `/usage`, `/sessions`, `/clear`, and `/quit`.

## 9. Acceptance Criteria

- The default screen no longer looks like a raw transcript log.
- Older turns remain visible enough for conversational continuity.
- Raw tool results, repeated read/search groups, and reasoning detail do not consume the viewport in default mode.
- Tool/activity rows appear before the final assistant answer.
- Tool calls, expanded tool results, user turns, and active streams use `●`, `⎿`, `❯`, and `▍` respectively.
- The current turn remains easy to find because it is nearest the input and carries live activity state.
- Claude-Code-like restraint is preserved: no large role cards or sidebars.
- Node remains a disposable UI process and does not own runtime state.

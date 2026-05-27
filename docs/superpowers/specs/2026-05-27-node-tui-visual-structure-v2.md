# Node TUI Visual Structure V2

## 1. Background

`node-tui-daily-ui-polish` added useful UI primitives: themes, local `/theme` and `/clear`, structured tool summaries, themed overlays, markdown rendering, and smoke coverage. The current visible shell still reads like a plain log transcript in the main conversation path.

The representative failure mode is a real TTY screenshot where the interface still appears sparse:

- header is two text rows, with the model isolated on the far right
- welcome logo sits inside the transcript and consumes vertical space
- user and assistant rows share almost the same visual treatment
- assistant answers are full-width text without a readable content column
- status text wraps at the bottom and looks broken
- theme tokens are present but not used to create visible structure

This slice changes the Node Ink **visual structure** of the main screen. It does not change Python runtime authority, JSON-RPC protocol ownership, tool execution, model calls, approvals, session persistence, or prompt construction.

## 2. Goals

### 2.1 Make the Main Screen Visibly Designed

The default interactive screen should no longer look like a plain transcript dump. It should have a clear terminal app anatomy:

```text
header band
compact welcome / session context
conversation transcript with distinct row types
running activity line
bottom command bar
stable status metadata
```

The desired feel is still a work-focused coding TUI, not a marketing page or decorative dashboard.

### 2.2 Fix the Screenshot-Level Problems

The implementation is accepted only if a similar conversation screen improves these concrete issues:

- model, session, workspace, theme, and context are arranged in a stable header/status structure
- the welcome mark does not permanently dominate the transcript after conversation starts
- user prompts and assistant answers are visually different without large role labels
- assistant text renders in a readable column instead of consuming the whole terminal width
- long Chinese and English lines wrap cleanly within the content column
- bottom status/input area does not wrap into a broken two-line layout at normal terminal widths
- themes visibly affect borders, markers, labels, and activity rows, not only individual text colors

### 2.3 Preserve Claude-Code-Like Restraint

Visual structure should come from spacing, borders, row markers, compact labels, and theme accents.

Do not add:

- large `USER` / `ASSISTANT` / `TOOL` role cards
- permanent right sidebar
- mouse-first UI
- decorative animation
- full-screen dashboard mode
- large nested boxes around every answer

### 2.4 Keep Node Disposable

All state introduced here is Node UI state only.

Allowed Node-local state:

- whether the welcome panel is compact or expanded
- computed terminal layout measurements
- active theme style variant
- display-only transcript row grouping
- running activity labels derived from current transcript/runtime events

Disallowed Node ownership:

- session history persistence
- model-visible transcript content
- tool execution state of record
- slash-command business logic other than existing Node-local `/theme` and `/clear`
- approval policy
- compaction, memory, provider, or prompt behavior

## 3. Non-Goals

- No Python gateway redesign.
- No JSON-RPC protocol expansion unless a test proves existing display data is insufficient.
- No custom theme editor or theme file format.
- No terminal mouse interactions.
- No full markdown engine.
- No transcript search or scrollback engine.
- No alternate app mode or dashboard mode.
- No deletion of the Python/Textual fallback.
- No changes to model prompts, skills, tools, approvals, or sessions.

## 4. Visual Design

### 4.1 Header Band

Replace the current two-row header with a compact header band.

Required content:

- left: `mycli` brand and workspace basename
- center or secondary segment: session id and view mode
- right: model name, context usage, and active theme

Rules:

- must fit on 80-column terminals without wrapping into visually broken rows
- may elide long values with middle truncation
- should use separators and theme accent/muted colors
- should not require a right sidebar

Example shape:

```text
 mycli  fix-deepseek-cache-hit-rate    session default · default    deepseek-v4-flash · 4% · graphite
 ──────────────────────────────────────────────────────────────────────────────────────────────────
```

At narrow widths, degrade by dropping low-priority fields in this order:

1. theme name
2. view mode
3. provider/model suffix
4. session label

The brand, workspace, and model family should remain visible when possible.

### 4.2 Compact Welcome Surface

The startup mark should not stay as a large transcript item once conversation content exists.

Required behavior:

- show the existing startup mark on a fresh empty transcript
- when there is user/assistant content, collapse welcome to a one-line session context or hide it
- keep workspace visible in the header/status instead of duplicating a full absolute path in the transcript

Acceptable compact line:

```text
 ready · /Users/cosmos/.../fix-deepseek-cache-hit-rate · /help for commands
```

The welcome surface is display-only. It must not add or remove Python transcript entries.

### 4.3 Transcript Row Types

Create focused transcript row components instead of one generic row for almost everything.

Required row components:

- `UserPromptRow`
- `AssistantBlock`
- `ToolTimelineRow`
- `CommandOutputRow`
- `SystemNoticeRow`
- `ExecutionStatusRow`

`Transcript.tsx` should route by `TranscriptItem.type` and keep routing logic readable. Large formatting details should live in row components or pure helpers.

### 4.4 User Prompt Row

User messages should be visually compact and easy to scan.

Required shape:

```text
› 你是谁
```

Rules:

- use the active theme accent for the prompt marker
- no `USER` label
- keep one blank line or controlled spacing after user turns only when it improves readability
- wrap long user messages inside the same content column as assistant blocks

### 4.5 Assistant Block

Assistant final answers should be visibly different from user input while staying restrained.

Required shape:

```text
  │ 我是 mycli，一个运行在你本地机器上的编程助手。
  │ ...
```

Rules:

- no `ASSISTANT` label
- use a subtle left rail or indentation
- render final markdown inside a bounded content column
- stream text as plain text while running, then reconcile to the final markdown block after `turn.completed`
- avoid boxing every answer with top/bottom borders

The content column should be width-limited. Recommended behavior:

- default max content width: 100 columns
- minimum usable content width: 56 columns
- terminal width below 80: use available width minus row marker/rail
- terminal width above 120: do not let paragraphs span the entire screen

### 4.6 Tool Timeline Row

Tool rows should look like activity telemetry, not prose.

Required shape:

```text
  read   pyproject.toml                      done 82ms
  grep   "NodeTuiGateway"                    8 matches
  bash   pytest -q                           exit 0
```

Rules:

- use aligned columns when enough width exists
- fall back to a compact single line on narrow terminals
- use status color for done/running/failed/unknown
- keep details folded by default
- never invent tool facts that are not in metadata/text

### 4.7 Running Activity Line

Replace a bare `Thinking...` with a compact running path.

Examples:

```text
  thinking 12s
  thinking 18s · read pyproject.toml
  thinking 31s · read → grep → edit
```

Rules:

- derive from local transcript/runtime events only
- show elapsed seconds while the turn is running
- do not store this in Python session history
- do not add animation unless it is stable in Ink tests and does not cause layout jitter

### 4.8 Bottom Command Bar

The input and status area should become a stable command bar, not two unrelated rows that wrap awkwardly.

Required content:

- prompt marker
- draft text or placeholder
- command hint when draft starts with `/`
- compact metadata line or right-aligned metadata segment

Suggested shape:

```text
──────────────────────────────────────────────────────────────────────────────────────────────────
› Type a message or /command                                      default · graphite · 3,983/100k
```

Rules:

- must not wrap at 80 columns in normal state
- if metadata is too long, truncate metadata before input
- pending approval/running state may replace lower-priority metadata
- keep restored draft behavior after interrupt

### 4.9 Theme Style Variants

Existing theme tokens remain. V2 adds display style rules for each built-in theme.

- `deep-teal`: accent rail, subtle dividers, clean technical console
- `graphite`: muted IDE-like dividers, blue-gray labels
- `mono`: minimal separators, no heavy color reliance
- `amber`: warm retro terminal accents without making the whole UI orange

Theme style variants are Node-only. They are derived from the active theme name and should not require Python config.

## 5. Architecture

### 5.1 Layout Helpers

Add a small Node UI layout helper module if needed:

```text
tui/node/src/app/layout.ts
```

Suggested helpers:

- `truncateMiddle(value, maxWidth)`
- `workspaceLabel(path, maxWidth)`
- `formatContextUsage(status)`
- `contentWidth(terminalWidth)`
- `splitHeaderSegments(...)`

These helpers should be pure and unit-tested. Avoid measuring actual terminal state inside helpers; pass widths in from components or test fixtures.

### 5.2 Component Boundaries

Suggested component changes:

```text
Header.tsx          -> HeaderBand
Transcript.tsx      -> router only, delegates row rendering
UserPromptRow.tsx   -> user message row
AssistantBlock.tsx  -> final/stream assistant rendering
ToolRow.tsx         -> timeline layout upgrade
InputBox.tsx        -> command bar prompt
StatusLine.tsx      -> either integrated into command bar or compact metadata component
WelcomePanel.tsx    -> collapsible startup surface
```

Do not create a large generic UI framework. Keep files small and tied to current TUI needs.

### 5.3 Transcript Data Flow

Existing `ShellState.transcript` remains the source for displayed conversation items.

Node may compute display-only derived values:

- whether the transcript has meaningful conversation content
- the last N tool calls for the running activity line
- compact workspace/session labels
- row display metadata

Node must not mutate Python transcript semantics. `/clear` remains visible-only clearing in Node.

### 5.4 Width Handling

The implementation should use Ink layout primitives and explicit width constraints.

Required behavior:

- no status/input wrap at 80 columns
- readable assistant content at 80, 120, and wide desktop terminal widths
- no full-width Chinese paragraphs on wide terminals
- long paths and model names truncate rather than displace core UI

Snapshot tests should cover at least:

- compact 80-column-ish layout
- normal 120-column-ish layout
- wide layout with long workspace/model strings

If Ink test utilities cannot set terminal columns directly, components should accept optional `width` props for deterministic tests.

## 6. Error Handling

- Invalid theme behavior remains local and non-fatal.
- Missing workspace/model/session values render as compact pending values without broken spacing.
- Unknown transcript item types fall back to a restrained text row.
- Extremely long unbroken words should be truncated or wrapped without corrupting adjacent UI.
- Overlay behavior from daily polish remains unchanged except for shared visual tokens if reused.

## 7. Testing

### 7.1 Required Node Tests

Add or update tests for:

- header band fitting and truncation
- command bar fitting and metadata elision
- welcome expanded on empty transcript and compact/hidden after conversation starts
- user prompt row
- assistant block with Chinese and English wrapping
- tool timeline alignment and narrow fallback
- running activity line
- integrated app snapshot matching the V2 anatomy

Required commands:

```bash
npm --prefix tui/node test
npm --prefix tui/node run typecheck
```

### 7.2 Required Python Regression Tests

Because the slice should not alter Python behavior, focused Python tests should still pass:

```bash
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q
```

### 7.3 Static Checks

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

### 7.4 Visual Smoke

Run a real TTY smoke after implementation:

```bash
MYCLI_TUI_THEME=deep-teal uv run mycli --session node-tui-visual-structure-v2-smoke
```

Manual checklist:

1. Empty session shows compact branded startup surface.
2. After first user turn, welcome no longer dominates the transcript.
3. User prompt and assistant answer are visually distinct.
4. Assistant answer has bounded width and readable Chinese wrapping.
5. Header and command bar do not wrap awkwardly.
6. `/theme graphite` visibly changes rails, separators, and labels.
7. `/usage` and `/sessions` overlays still work.
8. `/clear` clears visible transcript only.
9. `/quit` exits cleanly.

## 8. Migration Notes

This is a UI-only change. Existing sessions should render with the new visual structure without migration.

Old transcript items are still displayed from the same `TranscriptItem` fields. No session data rewrite is required.

## 9. Open Decisions For Plan

The implementation plan should decide:

- whether `StatusLine` remains separate or is folded into the command bar
- exact width prop strategy for deterministic Ink tests
- whether the welcome surface is hidden or collapsed after conversation starts
- whether assistant streaming gets a left rail immediately or only final answers do
- exact truncation priorities for header and command bar metadata

## 10. Acceptance Criteria

The work is complete only when:

- the main conversation screenshot no longer resembles a plain log transcript
- header/status/input remain stable at normal terminal widths
- welcome content does not permanently dominate active conversations
- assistant final answers render in a bounded, readable block
- tool rows read as structured timeline telemetry
- Node tests, TypeScript typecheck, focused Python tests, static checks, and full pytest pass
- scripted and manual TTY smokes are recorded in a dated report

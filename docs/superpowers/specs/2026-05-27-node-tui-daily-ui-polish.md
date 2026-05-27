# Node TUI Daily UI Polish

## 1. Background

`node-tui-shell` proved the Python agent can run behind a disposable Node Ink shell. The current shell is functionally correct, but visually sparse: transcript rows, tool summaries, overlays, status, input, and welcome content render with minimal hierarchy. This slice turns the shell from protocol-proven into daily-usable without changing the ownership boundary.

Python remains authoritative for runtime behavior, session history, tools, model calls, approvals, slash commands, usage, and model-visible context. Node remains authoritative only for terminal presentation and ephemeral UI state.

## 2. Goals

### 2.1 Add a Theme System

The Node UI should use semantic theme tokens instead of hard-coded colors.

Required built-in themes:

- `deep-teal`: default. Modern technical identity with teal accents.
- `graphite`: conservative blue-gray theme for long coding sessions.
- `mono`: high-contrast black/white terminal-native theme.
- `amber`: warm branded console theme, optional rather than default.

Required semantic tokens:

```text
background
surface
surfaceRaised
border
text
muted
subtle
accent
success
warning
error
code
```

Theme selection:

- `MYCLI_TUI_THEME=<name>` selects the startup theme.
- `/theme <name>` changes the active Node UI theme at runtime.
- `/theme` with no argument lists available themes and the current theme.
- Unknown themes should render a non-fatal command result and keep the current theme.

Theme state is Node UI state only. It must not enter Python session history, prompt context, memory, compaction, or model-visible messages.

### 2.2 Make the Branded Console Feel Work-Focused

The chosen direction is a Branded Console: visibly mycli, but not decorative. Brand expression should live in the UI structure and theme tokens rather than large illustrations or marketing-style panels.

Required branded surfaces:

- compact header or welcome mark
- prompt marker
- tool activity rows
- overlay title bars and borders
- status line
- approval prompt

Assistant answers stay restrained and highly readable. Do not wrap every assistant response in a card. Do not add a right sidebar. Do not add decorative or animated ornaments.

### 2.3 Improve Transcript Hierarchy

The transcript remains conversation-first and Claude Code-like.

Required behavior:

- No large role cards labeled `USER`, `ASSISTANT`, `TOOL`, or `REASONING`.
- User input uses a stable prompt marker and the active theme accent.
- Assistant text is plain and readable, with light markdown styling.
- Tool rows are compact and visually distinct from final answers.
- System notices and command output are lower emphasis than user and assistant content.
- `focus` view emphasizes final answers and hides non-error detail.
- `verbose` view expands tool details and command metadata supplied by Python.

Node may derive UI-only display labels from existing `TranscriptItem` fields, but it must not invent runtime facts.

### 2.4 Upgrade Tool Activity Rows

Current rows such as `. Read` should become structured execution telemetry.

Default examples:

```text
read  - pyproject.toml - done 82ms
edit  - src/mycli/cli/main.py - +14 -3
bash  - pytest -q - exit 0
grep  - "NodeTuiGateway" - 8 matches
```

Rules:

- Summaries are one line by default.
- Long arguments, stdout/stderr, diffs, and raw results remain folded.
- `verbose` view can show safe argument previews and Python-provided detail.
- Redaction policy stays in Python. Node only respects already-redacted fields.
- Unknown tools fall back to a generic but readable summary.

The tool summary formatter should be a tested Node helper, not ad hoc JSX string assembly inside `Transcript.tsx`.

### 2.5 Productize Overlays

Inspection commands should use a consistent overlay shell.

Required overlays:

- `/help`
- `/status`
- `/usage`
- `/context`
- `/sessions`
- `/release-notes`

Overlay shell requirements:

- themed border and title bar
- command name in title
- content area with readable wrapping
- footer hint such as `Esc close`
- no model-visible history writes
- no hidden mutation of Python session data

This slice does not need complex overlay search or scrollback. If content exceeds the viewport, the first implementation may show bounded content with a clear truncation indicator. Full scrollback can be a later slice.

### 2.6 Improve Status and Input

The bottom area should feel stable and intentional.

Status line should show:

- workspace name or shortened path
- session id when useful
- current view mode
- active theme
- model name
- context usage
- pending approval or suspended-turn indicator

Input line should show:

- themed prompt marker
- placeholder when empty
- distinct running/idle state
- restored draft after interrupt
- command mode hint when the draft begins with `/`

The layout must not jitter when context numbers, session ids, or model names change. Long paths should be truncated in the middle or reduced to the workspace basename.

### 2.7 Add Basic Markdown Rendering

Assistant text should render common markdown enough to read answers comfortably.

Required support:

- paragraphs
- inline code
- fenced code blocks
- unordered and ordered lists
- bold text

Non-goals:

- full CommonMark compliance
- markdown tables
- nested blockquote styling
- syntax highlighting for every language
- link opening or mouse interactions

Rendering must remain incremental enough for streamed assistant text. A pragmatic approach is acceptable: stream as plain text while the turn runs, then reconcile to markdown-rendered final text after `turn.completed`.

### 2.8 Keep Protocol Changes Minimal

Most work belongs in Node.

Python gateway changes are allowed only for:

- exposing `/theme` command metadata if command routing needs to recognize it
- passing theme names in bootstrap status if config support is added
- preserving current `command.run` behavior for unknown or Python-owned commands

Do not move slash-command business logic, model-visible state, approvals, tools, or session persistence into Node.

## 3. Non-Goals

- No theme editor.
- No user-defined custom theme file in this slice.
- No right sidebar.
- No transcript search.
- No complex scrollback engine.
- No mouse-first UI.
- No full markdown engine or rich syntax highlighting.
- No Python Textual deletion.
- No changes to model prompt construction.
- No changes to compaction, memory, tools, provider adapters, or approval policy.

## 4. Architecture

### 4.1 Theme Layer

Add a Node theme module under `tui/node/src/theme/`.

Suggested modules:

```text
tui/node/src/theme/types.ts
tui/node/src/theme/themes.ts
tui/node/src/theme/resolveTheme.ts
```

The theme layer exports:

- `ThemeName`
- `ThemeTokens`
- `THEMES`
- `resolveTheme(name: string | undefined): ThemeResolution`

`ThemeResolution` should preserve both successful and failed resolution:

```ts
type ThemeResolution =
  | { ok: true; name: ThemeName; theme: ThemeTokens }
  | { ok: false; fallbackName: ThemeName; theme: ThemeTokens; message: string };
```

### 4.2 State Layer

Extend `ShellState` with:

```ts
themeName: ThemeName;
theme: ThemeTokens;
themeNotice: string | null;
```

Add reducer actions:

```ts
theme.changed
theme.failed
```

Theme changes are local reducer actions. They do not need Python unless the final implementation chooses to expose `/theme` through the existing command pipeline for consistency.

### 4.3 Presentation Components

Add small, focused presentation components rather than making `Transcript.tsx` larger.

Suggested components:

```text
tui/node/src/app/Header.tsx
tui/node/src/app/ToolRow.tsx
tui/node/src/app/MarkdownText.tsx
tui/node/src/app/CommandOutput.tsx
tui/node/src/app/SystemNotice.tsx
```

Existing components should receive either `theme` or a narrow set of theme-derived props. Avoid importing global mutable theme state from components.

### 4.4 Tool Summary Formatter

Add a pure helper:

```text
tui/node/src/state/toolSummary.ts
```

It should accept a transcript item or gateway event metadata and return a typed display model:

```ts
type ToolSummary = {
  verb: string;
  target: string;
  status: "running" | "done" | "failed" | "unknown";
  detail?: string;
};
```

This keeps tool formatting testable without rendering Ink snapshots for every case.

## 5. Data Flow

Startup:

```text
env MYCLI_TUI_THEME
  -> Node resolveTheme()
  -> reducer initialState(theme)
  -> header/status/transcript render with theme tokens
```

Runtime theme command:

```text
InputBox sees /theme graphite
  -> Node local theme action when command is recognized as UI-only
  -> reducer updates themeName/theme/themeNotice
  -> transcript may show a local command_output row
```

Normal turn:

```text
Python gateway events
  -> Node GatewayClient
  -> reducer transcript state
  -> Transcript/ToolRow/MarkdownText render with active theme
```

Overlay:

```text
/usage
  -> Python command.run
  -> command.result presentation=overlay
  -> Overlay renders Python-provided lines inside themed shell
```

## 6. Error Handling

- Unknown theme from env: fall back to `deep-teal`, show a local non-fatal notice.
- Unknown theme from `/theme`: keep current theme, show a local command output row.
- Missing theme token in code should fail TypeScript typecheck.
- Markdown parse/render failure should fall back to plain text for that block.
- Tool summary formatter should never throw on missing metadata; it should produce a generic summary.
- Overlay content that exceeds bounds should truncate visibly instead of breaking layout.

## 7. Testing

Node tests:

- theme resolver tests for valid, missing, and unknown names
- reducer tests for theme changes and failed theme changes
- tool summary tests for Read, Edit, Bash, Grep, unknown tool
- component snapshot tests for Header, Transcript, ToolRow, Overlay, StatusLine, InputBox under at least `deep-teal` and `mono`
- markdown renderer tests for inline code, code block, list, bold, and plain fallback
- command handling tests for `/theme`, `/theme <valid>`, `/theme <invalid>`

Python tests:

- only needed if Python gateway command metadata changes
- preserve `--plain`, `MYCLI_TUI_BACKEND=textual`, and Node-default routing tests

Smoke:

- `npm --prefix tui/node test`
- `npm --prefix tui/node run typecheck`
- `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q`
- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`
- scripted Node smoke with `MYCLI_TUI_THEME=graphite`
- manual `uv run mycli --session node-tui-polish-manual-smoke`

Manual smoke checklist:

```text
1. Default theme is deep-teal.
2. MYCLI_TUI_THEME=graphite changes startup theme.
3. /theme mono changes theme without sending a model turn.
4. /theme nope shows an error and keeps the current theme.
5. Tool activity rows are compact and readable.
6. Assistant final answer renders basic markdown.
7. /usage and /sessions overlays use themed shell.
8. Status line shows workspace, view mode, theme, model, context.
9. /quit exits cleanly.
```

## 8. Acceptance Criteria

- Current Node TUI no longer reads as a bare protocol smoke.
- The default Branded Console style is `deep-teal`.
- Built-in themes can be switched without restarting.
- Theme state never enters Python model-visible history.
- User, assistant, tool, overlay, status, input, and approval surfaces share one semantic theme system.
- Tool rows provide useful one-line summaries in default view.
- Basic markdown is readable in final assistant answers.
- Existing scripted and manual Node TUI smokes still pass.
- Python runtime authority remains unchanged.

## 9. Open Decisions For Plan

- Whether `/theme` should be intercepted entirely in Node or also exposed as Python command metadata for consistency with other slash commands.
- Whether theme selection should persist across sessions in this slice or remain process-local plus env-configured.
- Whether markdown final rendering should use an existing small library or a narrow local renderer. Prefer a library only if it clearly reduces complexity and works well with Ink.
- Exact truncation behavior for oversized overlays.

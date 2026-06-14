# pi-agent TUI Lessons For mycli

This note captures what mycli should learn from the imported `coding-agent`
reference without copying its agent runtime.

## Core Judgment

pi-agent feels better because it has a real coding-agent UI architecture, not
because it merely uses `pi-tui`.

mycli should keep Python runtime and gateway ownership, but rebuild the
experimental pi-tui frontend around the same product primitives:

```text
runtime events -> typed shell state -> transcript block model -> pi-tui components
```

The current `pi-tui/examples/mycli-gateway.ts` is only a gateway proof. It still
renders mostly by joining strings. The next work should replace that line
renderer with components.

After reading the imported `coding-agent/src` tree, the stronger judgment is:

pi-agent is good because it treats the TUI as a product runtime with its own
stateful surfaces, not as a pretty printer for agent logs. The amount of code
is not the point. The important split is:

```text
AgentSession
  owns model, tools, bash, session, compaction, provider auth, command effects

InteractiveMode
  owns terminal lifecycle, input routing, selectors, component placement

Components
  own visual state: message blocks, tool executions, bash, footer, selectors

FooterDataProvider / Keybindings / SlashCommands
  provide stable product data and discovery surfaces
```

mycli should copy this separation of concerns, not the implementation details.

## Patterns Worth Learning

### 0. Stable Interactive Shell Layout

Reference file:

- `coding-agent/src/modes/interactive/interactive-mode.ts`

Useful behavior:

- The shell has named containers: header, chat transcript, pending messages,
  status, widgets above/below editor, editor, and footer.
- Containers are mounted once and updated by replacing child components.
- Runtime state updates request renders; they do not rebuild the whole terminal
  from raw strings.
- Startup starts the TUI first, then binds runtime/resources, then renders
  restored session messages.
- Resize, theme changes, git branch changes, and external editor returns all
  invalidate/request-render through the same UI object.

mycli migration target:

```text
PiGatewayApp
  HeaderContainer
  TranscriptContainer
  PendingContainer
  StatusContainer
  Overlay/Selector stack
  ComposerContainer
  FooterComponent
```

`mycli-gateway.ts` should become an app orchestrator. It should not contain
visual formatting logic or long command if/else chains.

### 1. Message Components

Reference files:

- `coding-agent/src/modes/interactive/components/user-message.ts`
- `coding-agent/src/modes/interactive/components/assistant-message.ts`

Useful behavior:

- User messages are separate blocks, not inline log rows.
- Assistant text is rendered as Markdown.
- Reasoning/thinking is a separate content block.
- Hidden reasoning shows a label, not raw reasoning text.
- Assistant final answer remains visually dominant.
- User and assistant blocks use OSC 133 prompt zone markers so modern terminals
  can identify prompt/output boundaries.
- Assistant messages update in place while streaming; completed messages do not
  get reinterpreted as generic logs.

mycli migration target:

```text
TranscriptItem -> TranscriptBlock -> Component

UserMessageBlock
AssistantMessageBlock
ReasoningBlock
SystemNoticeBlock
ErrorBlock
```

### 2. Tool Execution Components

Reference file:

- `coding-agent/src/modes/interactive/components/tool-execution.ts`

Useful behavior:

- Tool calls are stateful components with running/success/error states.
- Tool rows can be hidden when a renderer produces no meaningful content.
- Built-in tools can have specialized renderers.
- Call and result renderers are separate.
- Expanded/collapsed state is explicit.
- Image/result rendering is optional and capability-gated.
- Tool components retain renderer state across argument updates, execution
  start, partial result, final result, and expansion toggles.
- The tool component decides when to render nothing, which prevents low-value
  tool churn from becoming transcript noise.

mycli migration target:

```text
ToolSummary -> ToolExecutionBlock

ReadToolBlock
GrepToolBlock
EditToolBlock
WriteToolBlock
PatchToolBlock
BashToolBlock
GenericToolBlock
```

Default view should show important tools only:

- Always show mutating tools.
- Always show failed tools.
- Always show shell commands.
- Hide routine successful read/search tools unless verbose.
- Keep raw stdout/stderr hidden by default.

### 3. Bash Is Not Just Another Tool Row

Reference file:

- `coding-agent/src/modes/interactive/components/bash-execution.ts`

Useful behavior:

- Bash has a dedicated component for streaming output.
- It shows command, running loader, exit status, truncation, and expandable
  output preview.
- ANSI output is stripped or normalized before display.
- Full output is not dumped into the default transcript.
- `!command` and `!!command` are product-level input modes, not just tool calls.
  The editor border changes in bash mode, and the bash component owns its
  lifecycle.

mycli migration target:

```text
Bash tool lifecycle -> BashExecutionBlock

running: command + spinner
success: command + duration + bounded tail
failed: command + exit code + stderr/error preview
verbose/expanded: bounded full preview with log pointer
```

### 4. Footer As A Data Panel

Reference file:

- `coding-agent/src/modes/interactive/components/footer.ts`

Useful behavior:

- Footer is not marketing copy or random hints.
- It is a compact data surface: cwd, git branch, session name, token usage,
  cache, cost, context pressure, current model, extension status.
- It is width-aware and truncates safely.
- Footer data is separated from footer rendering through `FooterDataProvider`.
  Git branch watching and extension statuses do not leak into message rendering.
- The footer derives context pressure from session state, not from UI guesses.

mycli migration target:

```text
FooterData
  cwd
  git_branch
  session_id/title
  provider/model
  context_usage
  queue_count
  trust_state
  live_state
  approval/clarification markers

FooterComponent(width-aware)
```

### 5. Selectors And Overlays Own Interaction

Reference files:

- `coding-agent/src/modes/interactive/components/trust-selector.ts`
- `coding-agent/src/modes/interactive/components/model-selector.ts`
- `coding-agent/src/modes/interactive/components/session-selector.ts`
- `coding-agent/src/modes/interactive/components/settings-selector.ts`

Useful behavior:

- Trust/model/session/settings flows are selector components.
- They own focus while active.
- They support arrow keys, vim-style `j/k`, Enter, and cancel.
- They show footer hints from shared keybinding helpers.
- Selectors are not "text output plus prompt"; they are focused components with
  internal selection/search/delete/rename state.
- The generic `showSelector()` pattern creates the component, mounts it as an
  overlay, gives it focus, and restores editor focus when done.

mycli migration target:

```text
TrustSelector
ApprovalSelector
ClarificationSelector
SessionSelector
ModelSelector
CommandPalette
```

Trust prompt should be a pre-main gate, not transcript content.

### 6. Key Hints Are Centralized

Reference file:

- `coding-agent/src/modes/interactive/components/keybinding-hints.ts`

Useful behavior:

- UI copy does not hard-code key strings everywhere.
- Key display follows platform conventions.
- Hints use semantic styling.
- Keybindings are named product actions (`app.model.select`,
  `app.tools.expand`, `app.message.followUp`) rather than scattered raw keys.
- Components render hints from action names, so custom keybinding config updates
  UI copy automatically.

mycli migration target:

```text
keyHint(action, label)
rawKeyHint(keys, label)
footerHintsForState(state)
```

### 7. Command System Is A Product Surface

Reference files:

- `coding-agent/README.md`
- `coding-agent/src/core/slash-commands.ts`
- `coding-agent/src/modes/interactive/interactive-mode.ts`

Useful behavior:

- Commands are grouped by product purpose.
- Some commands return text, but many open selectors or overlays.
- Extension commands, skills, and templates share the same discovery surface.
- `/help`, completion, hotkeys, and command UI are generated from one command
  registry.
- Built-in commands are intentionally small records (`name`, `description`),
  while `InteractiveMode` decides whether the command opens a selector, mutates
  session state, runs an export/share flow, or dispatches to extensions.
- The command system is tied to autocomplete, not just submit-time parsing.

mycli migration target:

```text
CommandRegistry
  local commands
  runtime commands
  reserved commands
  future extension/plugin commands

CommandResult
  transcript text
  overlay
  selector
  mutation confirmation
```

Command categories to track:

- Session: `/sessions`, `/resume`, `/new`, `/title`, `/fork`, `/tree`
- Model/settings: `/model`, `/provider`, `/settings`, `/theme`
- Context/runtime: `/context`, `/usage`, `/compact`, `/retry`
- Safety: `/trust`, approvals, `/doctor`, `/terminal-setup`
- Files/changes: `/changes`, `/diff`, `/undo`, `/checkpoint`
- View: `/view`, `/details`, `/statusbar`, `/hotkeys`
- Utility: `/copy`, `/export`, `/clear`, `/quit`

### 8. Runtime Events Become Stateful Components

Reference files:

- `coding-agent/src/core/agent-session.ts`
- `coding-agent/src/modes/interactive/interactive-mode.ts`

Useful behavior:

- `AgentSession` emits semantic events such as queue updates, compaction start
  and end, retry start and end, session info changes, tool execution updates,
  and thinking-level changes.
- `InteractiveMode` keeps maps of pending tool components and streaming
  assistant components, then updates the matching component as events arrive.
- Session restoration renders from a structured session context: assistant tool
  calls and tool results are matched back into one tool component.

mycli migration target:

```text
Gateway events -> ShellState
ShellState diff -> existing component update
transcript restore -> match tool calls/results into ToolExecutionBlock
```

This is the piece that makes the UI feel stable rather than like a fast-moving
log tail.

### 9. Terminal Hygiene Is Owned By The TUI Runtime

Reference files:

- `@earendil-works/pi-tui` `ProcessTerminal`
- `coding-agent/src/modes/interactive/interactive-mode.ts`

Useful behavior:

- It uses the real `ProcessTerminal`, including stdin buffering, bracketed
  paste, resize handling, keyboard protocol negotiation, suspend/resume cleanup,
  and differential rendering.
- Interactive mode has explicit handlers for Ctrl-C, Ctrl-D, Ctrl-Z, external
  editor return, theme reload, and terminal diagnostics.
- Mouse and resize behavior are terminal-runtime concerns, not editor concerns.

mycli migration target:

```text
TtyTerminal should converge toward ProcessTerminal behavior:
  StdinBuffer
  mouse sequence filtering or explicit mouse support
  force redraw on resize
  raw mode cleanup
  bracketed paste
  terminal title/progress
```

The recent mycli pi-tui fixes for mouse movement and resize artifacts are
examples of this gap.

### 10. Theme Tokens Are Product Semantics

Reference files:

- `coding-agent/src/modes/interactive/theme/theme.ts`
- `coding-agent/src/modes/interactive/theme/*.json`

Useful behavior:

- Components ask for semantic colors (`toolPendingBg`, `thinkingText`,
  `bashMode`, `error`, `warning`, `accent`) instead of hard-coded ANSI colors.
- Theme switching invalidates components globally.
- Message/tool/footer components are readable because color encodes role and
  state, not decoration.

mycli migration target:

```text
PiThemeTokens
  text
  muted
  accent
  userMessageBg
  assistantText
  reasoningText
  toolPendingBg
  toolSuccessBg
  toolErrorBg
  bashMode
  footerDim
```

Then `mycli-shell-components.ts` can stop scattering local `style.cyan`,
`style.yellow`, etc.

## What Not To Copy

- Do not copy pi-agent's LLM/session runtime into mycli.
- Do not replace Python runtime ownership.
- Do not copy OAuth/provider implementation.
- Do not add extension execution semantics before mycli's command registry is
  stable.
- Do not make TUI components responsible for safety policy or file mutation.

## Recommended Migration Order

1. Keep command handling out of `mycli-gateway.ts`; use the pi-tui command
   registry as the single discovery/routing source.
2. Keep transcript rendering behind `ShellState -> TranscriptBlock -> Component`;
   do not reintroduce line formatting into the gateway entry.
3. Convert the current rendered-line components into mounted stateful component
   instances so tool/bash/assistant updates happen in place.
4. Add a `PiGatewayApp` shell with named containers matching
   `InteractiveMode`'s layout.
5. Add selector components for trust, approval, clarification, session, model,
   and settings. These should own focus and keyboard navigation.
6. Add a named keybinding layer and generate footer/hotkey copy from it.
7. Move footer data collection into a provider so cwd/git/model/context/queue
   are data inputs, not formatting side effects.
8. Replace raw ANSI style helpers with semantic mycli shell theme tokens.
9. Continue closing terminal-runtime gaps: resize, mouse, paste, suspend/resume,
   forced redraw, raw mode cleanup.

## Current mycli-shell Copy Boundary

The first copied/adapted layer now lives under `tui/mycli-shell`:

- `src/tui-core/` vendors the terminal/component runtime so mycli can build
  a real mounted terminal shell without depending on the imported example tree.
- `src/shell-runtime.ts` mirrors `coding-agent`'s `InteractiveMode`
  assembly pattern: `TUI + ProcessTerminal`, named header/chat/pending/status/
  editor/footer containers, focused editor input, slash command palette, and
  Trust selector.
- `src/components/shell-editor.ts` wraps the vendored `Editor` with app-level actions
  (`Esc`, `Ctrl-D`, `?`, `Ctrl-O`) instead of scattering raw input handling.
- Message/tool/bash/footer components remain mycli-owned and should receive
  projected mycli gateway state.

The next migration step is not more static rendering polish. It is the gateway
adapter:

```text
mycli node protocol events
  -> MycliShellState projection
  -> MycliShellRuntime.setState()
  -> mounted mycli shell components
```

Keep this boundary: copy the shell/component architecture, but keep Python
mycli as the source of truth for agent runtime, tools, approvals, sessions,
filesystem snapshots, context, and model/provider behavior.

## Acceptance Markers

- Final assistant answer is visually dominant and Markdown-rendered.
- Reasoning is never mixed into final answer, header, or footer.
- Routine read/search tools do not flash through default transcript.
- Failed tools show useful detail previews without raw dumps.
- Bash output has a dedicated preview/expand path.
- Slash commands are discoverable from one registry.
- Selectors own keyboard focus and provide visible hints.
- All visible lines stay within terminal width.

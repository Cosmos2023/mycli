# P5 CLI Experience

## 1. Background

P0-P4 made the runtime more stable: context metrics exist, streaming works on the main chat-completions path, `/usage` and `/context` expose diagnostics, file diffs are attached to turn items, and recovery behavior is observable. The remaining gap is daily ergonomics. Claude Code still feels faster to operate because status, context, paths, verbosity, and diffs are easier to scan while staying in the terminal.

This P5 slice improves the CLI without turning mycli into a full TUI. It keeps the existing line-oriented REPL and rendering pipeline, uses the dependencies already present in the project (`rich`, `pygments`), and avoids new dependencies.

## 2. Goals

### 2.1 Statusline / context percent

Add a compact statusline that can be printed before each prompt and queried with a slash command.

Minimum statusline fields:

- session id
- model
- provider/protocol
- context usage percentage when available
- last known input/total token count and max prompt tokens when available
- pending decision / suspended turn flags

The statusline must be deterministic text by default:

```text
[status] session=demo model=deepseek-v4-flash provider=deepseek/chat_completions context=29.7% tokens=3566/12000 pending=no suspended=no
```

If context metrics are unavailable, the line must still be useful:

```text
[status] session=demo model=deepseek-v4-flash provider=deepseek/chat_completions context=unknown pending=no suspended=no
```

### 2.2 View modes

Add `view_mode` to runtime config with three supported values:

- `default`: current behavior, plus concise statusline when enabled.
- `verbose`: include activity, progress, stream, warnings, statusline, and detailed diff lines.
- `focus`: suppress low-value activity noise and repeated stream echoes; keep final answer, pending decisions, warnings/errors, and compact status.

View mode must affect only CLI rendering. It must not change model-visible context, turn history, recovery behavior, tools, or provider requests.

Configuration precedence:

```text
MYCLI_VIEW_MODE > project config > user config > default
```

The REPL must support:

```text
/view
/view default
/view verbose
/view focus
```

### 2.3 Path autocomplete

Add lightweight path autocomplete for `@path` fragments in the REPL input prompt when `readline` is available.

Behavior:

- Complete only the current token when it starts with `@`.
- Resolve paths relative to the workspace root.
- Do not complete outside the workspace.
- Return directory suggestions with a trailing `/`.
- Keep plain input working when `readline` is unavailable or stdin is non-interactive.

This is a convenience feature only. It must not affect parsing, model prompts, or tool inputs.

### 2.4 Diff rendering v2

Improve diff rendering while preserving current line-oriented fallback.

Required behavior:

- Keep existing numbered `[diff]` lines for plain output.
- Add compact folding for large diffs:
  - default max rendered diff lines: 80
  - omitted tail rendered as `[diff] ... <N> lines omitted`
- Add a rich-compatible diff object/path through existing `render_diff_view()` for future callers.
- Add `/view verbose` behavior that can raise the diff line cap for CLI output.

Non-goal: interactive expand/collapse UI. This P5 does not implement keyboard-driven diff navigation.

### 2.5 Help and command discoverability

Update `/help` to include:

- `/status`
- `/view [default|verbose|focus]`

Keep existing commands stable.

## 3. Non-Goals

- No full-screen TUI.
- No prompt_toolkit dependency.
- No voice mode.
- No vim/normal editor mode.
- No terminal title rename automation.
- No changes to provider protocol, model requests, or session transcript format.
- No semantic parsing of `@path`; autocomplete only suggests text.

## 4. Design

### 4.1 Config

Add two config fields to `AgentConfig`:

```python
view_mode: Literal["default", "verbose", "focus"] = "default"
statusline_enabled: bool = True
```

Use a domain-level type alias or enum if that fits current patterns better. Invalid view mode values must fail config resolution with a clear `ValueError`.

Parse:

- `MYCLI_VIEW_MODE`
- `MYCLI_STATUSLINE_ENABLED`
- `view_mode`
- `statusline_enabled`

### 4.2 Status data

Keep statusline construction in application/CLI boundary code, not inside model runtime logic.

Add a `TurnService.inspect_status()` method that returns one or more text lines. It can reuse:

- `self._config`
- `SessionService` pending decision / suspended turn lookups
- `ObservabilityService.snapshot()` context metrics

Do not make statusline depend on current terminal width.

### 4.3 Rendering policy

Introduce a small rendering options object in `src/mycli/cli/rendering.py`:

```python
@dataclass(slots=True, frozen=True)
class RenderOptions:
    view_mode: str = "default"
    diff_max_lines: int = 80
    show_statusline: bool = True
```

Rendering functions should accept options where needed. Existing call sites should keep default behavior if no options are provided.

`focus` mode should suppress:

- tool exposure activity lines
- reasoning lines that are already semanticized as generic task-understanding noise
- stream echo lines when final answer is identical to streamed chunks

`focus` mode must not suppress:

- errors
- warnings
- pending decisions
- approval prompts
- final answer
- explicit progress updates that start with `[decision]`, `[heartbeat]`, or `[resume]`

### 4.4 REPL state

The REPL currently receives function callbacks and does not own application state. Keep that pattern:

- Add optional `statusline_provider: Callable[[], Iterable[str]] | None`.
- Add optional `view_mode_provider` / `view_mode_setter` callbacks, or a small command handler route through `TurnService`.
- Print statusline before each prompt only when enabled.

The simplest acceptable design is:

- `/status` routed through `build_command_handler(service)`.
- `/view` routed through `build_command_handler(service)`.
- `run_repl()` gets `statusline_provider` and calls it before reading each input.

### 4.5 Autocomplete

Create `src/mycli/cli/autocomplete.py` with one focused responsibility: install readline completion for `@path`.

Public function:

```python
def install_path_autocomplete(*, workspace_root: Path) -> Callable[[], None]:
    ...
```

It returns a cleanup function that restores the previous completer. If `readline` cannot be imported, return a no-op cleanup.

The completer should be independently testable through pure helpers:

```python
def path_completion_candidates(workspace_root: Path, token: str) -> tuple[str, ...]:
    ...
```

### 4.6 Data safety

Statusline and view mode output must not be stored as model-visible messages. They may appear in CLI output and logs if already captured by the terminal, but must not be appended to conversation/history items.

Autocomplete must never list files outside the workspace. Symlink handling should use the existing path utilities if practical; otherwise resolve candidate paths and reject anything whose resolved path is outside `workspace_root.resolve()`.

## 5. Acceptance Criteria

- `/help` lists `/status` and `/view [default|verbose|focus]`.
- `/status` prints a compact session/model/provider/context line.
- Statusline can be emitted before the prompt in normal REPL mode and omitted when disabled.
- `MYCLI_VIEW_MODE=focus` suppresses low-value activity/stream echo but keeps final answer and warnings/errors.
- `/view verbose` and `/view focus` update the current session config without restarting.
- `@path` autocomplete suggests workspace-relative files/directories and refuses outside-workspace traversal.
- Large diffs render with an omitted-line marker by default; verbose mode can render a larger cap.
- Full verification passes:
  - `uv run ruff check src tests`
  - `uv run mypy src/mycli`
  - `uv run pytest -q`

## 6. Recommended Implementation Order

1. Config and `TurnService.inspect_status()`.
2. `/status` and `/view` command handling.
3. Render options and focus/verbose behavior.
4. Diff rendering v2.
5. Readline `@path` autocomplete.
6. Smoke report and gap doc update.

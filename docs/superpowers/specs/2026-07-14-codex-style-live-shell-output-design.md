# Codex-Style Live Shell Output Design

## Goal

Render agent Shell execution like Codex: one stable command cell that shows a
short command preview, streams output while running, and changes in place to a
completed or failed state. Keep the default transcript compact while retaining
full details on explicit expansion.

## Existing Capabilities

The backend already emits ordered `shell.started`, `shell.output`, and terminal
shell lifecycle events. Each event carries `shell_id`, `call_id`, sequence,
command preview, output delta, process state, and terminal metadata.

The Node TUI already reduces these events into one transcript item and updates
the mounted component in place. This design does not introduce a second shell
protocol or replace the shell session manager.

## Command Cell States

### Running

Render one compact header:

```text
* Running pytest -q (12s · esc to interrupt)
```

- Show a sanitized command preview capped at 72 characters.
- For multiline commands, show only the first meaningful line plus an ellipsis.
- Append output deltas to the existing cell using `shell_id`/`call_id` identity.
- Show the latest five visual output lines while the process is running.
- Keep the elapsed time and foreground interrupt hint.
- Background processes omit the foreground interrupt hint.

### Completed

Update the same cell in place:

```text
* Ran pytest -q
  └ 1989 passed, 18 skipped in 55.53s
```

- Use success or error status styling from the existing theme.
- Show at most five visual output lines in the collapsed state.
- When output exceeds the budget, preserve useful head and tail lines with one
  omission marker between them.
- Preserve exit code, timed out, interrupted, and killed details.

### Expanded

Expansion reveals:

- the complete command;
- all output retained by the bounded runtime buffer;
- shell profile and PowerShell edition;
- terminal status and non-zero exit code.

Expansion does not request new model work or rerun the command.

## History Reload

Persisted Shell tool call/result records project into the same command cell
model used by live lifecycle events. Reloading a session must not switch to a
generic tool row or expose an unbounded command in the collapsed header.

Historical output remains bounded by backend snapshot limits. The TUI applies
the same five-line collapsed presentation as live output.

## Output Truncation

Use state-aware presentation:

- Running: keep the newest five visual lines so progress remains current.
- Completed/failed: preserve a balanced head and tail within five visual lines,
  reserving one line for the omission marker.
- Expanded: render all output available in `outputPreview`; backend omission
  markers remain authoritative when older bytes were discarded.

Truncation operates on rendered terminal rows, not JavaScript string length, so
wrapped CJK text and long paths obey the same screen budget.

## Scope

Modify the Node TUI command-cell presentation and tests only. Backend shell
lifecycle events, output buffer limits, process management, approval behavior,
and model-visible tool results remain unchanged unless a regression test proves
a missing event field.

## Tests

Add or update tests proving:

- output deltas update the existing Shell transcript item;
- a mounted command component is reused during output streaming;
- running cells show the newest five visual output lines;
- completed cells preserve head and tail with an omission marker;
- long and multiline commands remain bounded in collapsed state;
- expansion reveals the complete command and retained output;
- completion, failure, timeout, interruption, and background states retain
  their existing status details;
- historical Shell records render with the same collapsed command cell.

Run Node tests and TypeScript checks, then the Python gateway and full regression
suites because shell lifecycle payloads cross the Python/TypeScript boundary.

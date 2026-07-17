# Codex-Style Unified Shell Runtime Design

## Status

Ready for user review on 2026-07-17.

## Summary

mycli will replace its model-visible foreground/background Shell split with a Codex-style
unified execution contract:

- ordinary commands use byte-streaming pipes by default;
- callers may request a PTY with `tty: true`;
- every process initially waits for a bounded `yield_time_ms` interval;
- a process that is still running after that interval becomes a resumable Shell session;
- `WriteStdin` polls a running session or writes interactive input to a PTY;
- Linux and macOS use native PTYs, while Windows uses ConPTY;
- legacy `run_in_background`, `ShellOutput`, `BashOutput`, and `KillShell` calls remain accepted
  by the runtime but are not exposed to models in new turns.

The existing shell IDs, bounded output buffers, lifecycle events, task notifications, approval
flow, session ownership, and Codex-style TUI Shell card remain in place. The main architectural
change is a transport layer below `ShellSessionManager`.

## Context

The current Shell runtime already has several useful Codex-style properties:

- a process is represented by a stable shell ID;
- output is retained in a bounded head/tail buffer;
- foreground and background processes share one lifecycle manager;
- lifecycle events update one TUI card in place;
- `ShellOutput` results are merged back into the originating Shell card;
- timeout, interruption, process-tree cleanup, and completion notifications are centralized;
- shell profiles support POSIX shells, PowerShell, and CMD across Linux, macOS, and Windows.

The remaining execution behavior is still closer to Claude Code:

- the model must choose `run_in_background` before execution;
- foreground execution blocks until completion or timeout;
- background continuation uses a separate `ShellOutput` concept;
- `subprocess` streams are opened in text mode and consumed by line iteration;
- a partial line is not delivered until a newline, EOF, or upstream flush makes it visible;
- running sessions cannot accept arbitrary stdin;
- no PTY or ConPTY transport is available.

Codex separates process lifecycle from process transport. Its ordinary path uses pipes and reads
available byte chunks without waiting for line boundaries. PTY allocation is optional and is used
when terminal semantics or interactive stdin are required. mycli will adopt that separation while
keeping its existing Python runtime and public Shell identity.

## Goals

1. Deliver partial output before a newline when the child process has flushed those bytes.
2. Use plain pipes by default, matching Codex's non-interactive execution path.
3. Support optional PTY execution on Linux and macOS and ConPTY execution on Windows.
4. Replace explicit background selection with bounded yielding and resumable sessions.
5. Provide one continuation tool for polling, stdin writes, and interrupt delivery.
6. Preserve the current lifecycle event and TUI single-card behavior.
7. Preserve old sessions and external callers through hidden compatibility adapters.
8. Keep model-visible output bounded, deterministic, and free of XML-style wrapper tags.
9. Maintain current shell safety, approval, sandbox, timeout, and ownership guarantees.

## Non-Goals

- Do not port Codex's Rust process runtime into mycli.
- Do not introduce a Rust sidecar or a new IPC protocol.
- Do not turn the Node TUI into a complete terminal emulator.
- Do not promise correct rendering of full-screen programs such as `vim`, `top`, or `less`.
- Do not persist live OS processes across a mycli application restart.
- Do not expose separate tools for Bash, PowerShell, CMD, PTY, or ConPTY.
- Do not force PTY allocation for ordinary commands.
- Do not remove legacy runtime aliases until a later compatibility cleanup.
- Do not change the existing shell safety grammar or approval policy in this work.

## Design Principles

1. **PIPE is the default.** PTY is an explicit capability, not a workaround for slow output.
2. **Transport is replaceable.** Session lifecycle code must not branch on platform mechanics.
3. **Yielding is not completion.** A yielded process stays alive and keeps the same shell ID.
4. **Polling is transport.** Empty `WriteStdin` calls must not create separate visible TUI cards.
5. **Output is bounded twice.** Runtime retention and per-call model output have independent limits.
6. **Compatibility is one-way.** New models see only the new contract; old calls remain executable.
7. **Observed state wins.** Failed interruption or termination must never be reported as completion.
8. **Terminal controls are untrusted.** Child output cannot inject arbitrary control sequences into
   mycli's own TUI.

## Model-Visible Tool Contract

### Shell

The model-visible tool remains named `Shell`, preserving mycli's shell-aware abstraction while
adopting Codex execution semantics.

```json
{
  "command": "pytest -q",
  "cwd": "/repo",
  "tty": false,
  "yield_time_ms": 10000,
  "max_output_tokens": 10000
}
```

Parameters:

| Parameter | Required | Default | Behavior |
| --- | --- | --- | --- |
| `command` | yes | none | Command text interpreted by the active shell profile |
| `cwd` | no | workspace root | Native working directory |
| `tty` | no | `false` | Allocate PTY or ConPTY when true |
| `yield_time_ms` | no | `10000` | Initial wait, clamped to 250-30000 ms |
| `max_output_tokens` | no | `10000` | Per-response model output budget, subject to policy cap |

`run_in_background` and `timeout` are no longer included in the model schema. The configured Shell
execution timeout remains an internal upper bound. Legacy calls may still supply both fields.

Execution behavior:

1. Resolve safety, approval, shell profile, cwd, environment, and execution timeout.
2. Allocate a shell ID and start the selected transport.
3. Emit `shell.started` immediately.
4. Collect output until the process exits, the request is interrupted, or `yield_time_ms` expires.
5. If the process exits, return its terminal result.
6. If the deadline expires, mark the same session `running_background`, emit
   `shell.list.updated`, and return its session ID with the output collected so far.

There is no second process launch and no process migration when a command yields.

### WriteStdin

```json
{
  "session_id": "a1b2c3d4",
  "chars": "",
  "yield_time_ms": 250,
  "max_output_tokens": 10000
}
```

Parameters:

| Parameter | Required | Default | Behavior |
| --- | --- | --- | --- |
| `session_id` | yes | none | Existing Shell session ID |
| `chars` | no | empty string | Bytes to write after UTF-8 encoding |
| `yield_time_ms` | no | `250` | Wait for new output or exit after the write/poll |
| `max_output_tokens` | no | `10000` | Per-response model output budget |

Behavior:

- Empty `chars` performs a bounded wait for new output or process completion.
- Non-empty `chars` writes to a PTY/ConPTY session and then waits for output.
- A pipe session rejects non-empty input because its stdin is closed by design.
- The interrupt character (`\u0003`) is accepted for both transport kinds and maps to the existing
  process-tree interrupt operation for pipe sessions.
- Calls for one session are serialized by a per-session interaction lock.
- Output returned to the model is incremental from that session's model cursor.
- A completed session returns its remaining output and terminal status idempotently until cleanup.

`WriteStdin` replaces model-visible `ShellOutput`. It does not replace TUI Escape handling or user
commands such as `/stop`, which continue to call the manager directly.

## Model Output Shape

Completed Shell response:

```text
Chunk ID: 7f31c2a8
Wall time: 0.42 seconds
Process exited with code 0
Final output:
120 passed in 0.31s
```

Yielded Shell response:

```text
Chunk ID: 30b9d104
Wall time: 10.01 seconds
Process running with session ID a1b2c3d4
Live output:
collecting tests...
```

`WriteStdin` uses the same shape. It reports either a running session or the final exit status and
contains only output not already consumed by the model cursor.

Rules:

- Do not wrap output in `<output>` or another synthetic tag.
- Generate a new chunk ID for every tool response, not every process.
- Report exact exit codes when known.
- Track original token count before response truncation.
- Truncate only the returned response; do not shrink the process's retained output because one
  model call used a small budget.
- Use the existing head/tail truncation policy and include one stable omission marker.
- Keep headings and field order stable to improve prompt-cache reuse.

## Transport Architecture

Add a package below `ShellSessionManager`:

```text
src/mycli/tools/shell_transport/
├── __init__.py
├── base.py
├── factory.py
├── pipe.py
├── unix_pty.py
└── windows_conpty.py
```

The central protocol is intentionally process-oriented rather than `subprocess.Popen`-oriented:

```python
class ShellProcessTransport(Protocol):
    tty: bool

    def read_chunks(self) -> Iterator[ShellOutputChunk]: ...
    def write(self, data: bytes) -> None: ...
    def poll(self) -> int | None: ...
    def wait(self) -> int: ...
    def interrupt(self) -> ProcessTerminationOutcome: ...
    def terminate(self) -> ProcessTerminationOutcome: ...
    def resize(self, rows: int, columns: int) -> None: ...
    def close(self) -> None: ...
```

`ShellOutputChunk` contains bytes, a stream label, and a monotonic sequence. Stream labels are
`stdout`, `stderr`, or `terminal`. Sequence assignment occurs when a reader publishes a chunk so
the combined output has deterministic arrival ordering within one runtime.

`ShellSessionManager` owns transport instances instead of raw `Popen` objects. It continues to own
session IDs, output buffers, cursors, event throttling, timeout watchers, completion notification,
and cleanup policy.

### PipeTransport

- Spawn with `text=False` and unbuffered binary pipes.
- Close stdin at launch.
- Read stdout and stderr concurrently in chunks of up to 8192 bytes.
- Publish bytes as soon as the operating system read completes; do not wait for newline boundaries.
- Preserve separate stdout and stderr buffers and append both to the combined ordered buffer.
- Reuse the current process-group creation and process-tree termination behavior.

This improves mycli's delivery latency, but it cannot override buffering performed inside the child
process. Programs that require terminal detection must use `tty: true`.

### UnixPtyTransport

- Use the Python standard library PTY facilities on Linux and macOS.
- Open a master/slave PTY pair and attach child stdin, stdout, and stderr to the slave.
- Start the child in its own session/process group.
- Read the master in binary chunks and expose a single `terminal` stream.
- Write stdin through the master.
- Support terminal resize through `TIOCSWINSZ`.
- Close duplicated slave descriptors in both parent and child paths.

### WindowsConPtyTransport

- Use a Windows-only `pywinpty` dependency locked and installed only on Windows.
- Start the active PowerShell, CMD, or explicitly selected POSIX shell through ConPTY.
- Expose one combined terminal stream, stdin writes, resize, exit polling, and termination.
- Preserve the existing Windows process-tree cleanup fallback when ConPTY termination does not
  conclusively stop descendants.
- Fail with a specific `conpty_unavailable` error when the platform cannot provide ConPTY.

Linux and macOS must not import the Windows dependency. Windows must not import Unix-only modules.
The factory performs lazy platform imports so all modules remain importable in cross-platform tests.

## Output Decoding And Terminal Safety

Each stream owns an incremental decoder selected from the active shell environment, defaulting to
UTF-8 with replacement for invalid byte sequences. Incremental decoding prevents a multibyte
character split across chunks from producing duplicate replacement characters.

Before output enters model-visible or persisted buffers:

- normalize CRLF to LF;
- convert remaining carriage-return updates into stable append-only lines;
- process backspace conservatively within the current line;
- strip SGR color sequences from persisted/model-visible output;
- discard OSC, title-change, clipboard, and unsupported terminal-control sequences;
- retain ordinary Unicode text and line breaks.

The Node TUI applies its own semantic colors. Child processes cannot directly style or control the
mycli screen.

This design supports interactive line-oriented programs, prompts, progress updates, and colored
CLI tools. It does not emulate a complete terminal screen buffer, alternate screen, cursor-addressed
interfaces, or full-screen applications.

## Yielding And Session State

Replace the static foreground/background choice with these states:

```text
starting
running_foreground
running_background
completed | failed | timed_out | interrupted | killed
```

All sessions begin as `running_foreground`. At the initial yield deadline, an unfinished session
atomically changes to `running_background`. The transition:

- does not restart the process;
- does not reset output cursors;
- does not create another transcript item;
- emits `shell.list.updated` for the footer and `/ps` view;
- changes the existing TUI card from active foreground execution to resumable execution.

A process may complete concurrently with the yield deadline. The manager uses the per-session lock
and observed process status to choose exactly one transition. Terminal state always wins over a
background transition.

## Lifecycle Events And TUI

The existing event names remain stable:

```text
shell.started
shell.output
shell.completed
shell.list.updated
shell.removed
```

Output remains coalesced for UI efficiency, initially using the existing 50 ms interval and 4096
character event cap. Byte-stream reading improves the earliest available output without forcing a
redraw for every byte.

The TUI continues to render one Shell block:

```text
• Running pytest -q (3s · esc to interrupt)
└ collecting tests...
```

After yield:

```text
• Running pytest -q (12s)
└ 43% complete
```

After completion:

```text
• Ran pytest -q
└ 120 passed in 18.2s
```

TUI rules:

- Empty `WriteStdin` polls are never rendered as separate tool blocks.
- Non-empty writes update the same Shell block and may show a generic `input sent` interaction;
  input text is not echoed by mycli because it may contain secrets.
- The collapsed Shell preview retains the existing five-line budget.
- `Ctrl+O` shows the complete retained output and full command.
- Foreground cards show `esc to interrupt`; yielded/background cards do not.
- Resume history uses the same Shell block projection as live events.
- Legacy `ShellOutput` transcript items continue to coalesce into their originating Shell block.

No raw ANSI or OSC sequence may pass from process output into the TUI renderer.

## Compatibility

New model tool lists expose:

- `Shell`
- `WriteStdin`

The runtime continues to accept these hidden aliases:

- `Bash` -> `Shell`
- `ShellOutput` -> an immediate legacy poll
- `BashOutput` -> an immediate legacy poll
- `KillShell` -> manager termination

Legacy Shell arguments are adapted as follows:

- `run_in_background: true` starts the process and yields as soon as startup succeeds, preserving
  the old immediate-background behavior.
- `run_in_background: false` with no `yield_time_ms` waits until terminal state or the legacy
  timeout, preserving old external caller behavior.
- legacy `timeout` is validated and applied as the internal process lifetime for that call.
- `shell_id` and `bash_id` are accepted as aliases for `WriteStdin.session_id` in runtime adapters.

Persisted IDs remain eight-character strings. The new field is named `session_id` only at the model
tool boundary; it maps directly to the existing shell ID.

Old transcript rows, hooks, plugins, provider replay, and approval records do not need migration.
Compatibility aliases are omitted from new model schemas to avoid duplicate tool choice and prompt
token overhead.

## Concurrency And Ownership

- Different Shell sessions may run concurrently under the existing session limit.
- Interactions for one Shell session are serialized.
- A `WriteStdin` call may access only a session owned by the active mycli session.
- Model output cursors and lifecycle/TUI cursors remain separate consumers.
- A slow TUI listener cannot block process output readers; lifecycle delivery stays coalesced and
  isolated from transport reads.
- Parallel Shell tool calls each receive an independent session and output budget.
- The agent orchestration layer continues to wait for a whole returned tool-call batch before the
  next model request; this design does not introduce per-output model requests.

## Timeout, Interruption, And Cleanup

The configured execution timeout remains an absolute process lifetime, independent of yield and
poll durations. Repeated `WriteStdin` calls do not extend it.

Termination behavior:

1. User Escape or `\u0003` requests an interrupt.
2. The transport performs the platform-native interrupt operation.
3. Existing escalation waits and process-tree termination remain in force.
4. The manager observes the process before assigning a terminal state.
5. If cleanup is inconclusive, the session remains running and reports a concrete cleanup error.

Transport resources are closed after readers have drained remaining bytes. Completion emits one
final output event before `shell.completed`. Session eviction never discards a live process without
first attempting termination and recording the observed result.

## Error Handling

Structured error kinds include:

| Error | Meaning |
| --- | --- |
| `shell_spawn_failed` | Process or transport could not start |
| `pty_unavailable` | Unix PTY could not be allocated |
| `conpty_unavailable` | Windows ConPTY is unsupported or unavailable |
| `shell_not_found` | Session ID is unknown or already evicted |
| `shell_session_forbidden` | Session belongs to another owner |
| `stdin_closed` | Non-empty input was sent to a pipe session |
| `shell_already_completed` | An operation requires a live process |
| `shell_write_failed` | PTY/ConPTY input write failed while process remained live |
| `shell_resize_failed` | Requested terminal resize failed |
| `shell_decode_warning` | Invalid output bytes required replacement |

Spawn failure does not register a session. A failed stdin write refreshes process state before
deciding whether to return `shell_write_failed` or normal terminal completion.

## Persistence And Observability

Visible Shell transcript snapshots continue to persist command preview, retained output, state,
exit code, timing, shell kind, and shell ID. Add these metadata fields:

```json
{
  "transport": "pipe",
  "tty": false,
  "yielded": true,
  "yield_count": 2,
  "output_bytes": 18432,
  "decode_replacement_count": 0
}
```

Do not persist raw PTY bytes, stdin contents, private environment variables, or absolute shell
executable paths. Trace events record transport kind, timings, byte counts, truncation counts,
terminal state, and cleanup result.

After application restart, historical Shell cards remain visible but their process sessions are not
reconstructed. `WriteStdin` against such a historical ID returns `shell_not_found`.

## Dependency And Packaging Strategy

- Linux/macOS PTY support uses the Python standard library and existing OS APIs.
- Windows adds `pywinpty` as a `sys_platform == 'win32'` project dependency.
- The resolved Windows wheel is locked in `uv.lock` and validated against Python 3.13 in CI.
- Importing mycli on non-Windows platforms must not import or require `pywinpty`.
- If a compatible Windows wheel is unavailable during implementation verification, ConPTY work is
  blocked rather than silently falling back when `tty: true` was requested. Default PIPE execution
  remains operational.

## Testing Strategy

### Transport contract tests

Run the same contract suite against fake, pipe, Unix PTY, and Windows ConPTY transports where the
platform is available:

- start, poll, wait, exit code, interrupt, terminate, close;
- output before newline;
- output chunk larger than 8192 bytes;
- UTF-8 code point split across chunks;
- stdout/stderr separation for pipe and merged stream for PTY;
- stdin write and response for PTY;
- stdin rejection for pipe;
- resize behavior;
- process-tree cleanup.

### Session manager tests

- completion before initial yield;
- automatic foreground-to-background transition;
- completion racing the yield deadline;
- incremental model cursor independent from lifecycle cursor;
- empty `WriteStdin` waiting for output;
- non-empty write followed by output and completion;
- absolute timeout unaffected by repeated polls;
- final output event ordered before completion;
- owner isolation and per-session interaction serialization;
- head/tail retention and per-call token budgeting.

### Compatibility tests

- old `run_in_background` true and false behavior;
- `ShellOutput` and `BashOutput` aliases;
- `KillShell` alias;
- old transcript coalescing on resume;
- old approval and hook payload acceptance;
- new model schemas omit legacy names and arguments.

### TUI tests

- partial output updates an existing running card;
- yield removes the foreground interrupt hint without creating a second card;
- empty `WriteStdin` creates no visible tool card;
- non-empty input does not expose input text;
- completed output uses balanced head/tail preview;
- ANSI, OSC, carriage return, and backspace sequences cannot corrupt layout;
- live and resumed histories produce equivalent Shell blocks.

### Cross-platform integration tests

The existing Ubuntu, macOS, and Windows CI matrix runs:

- default pipe command with partial output before newline;
- default pipe non-zero exit;
- automatic yield and subsequent empty poll;
- timeout and interruption;
- native PTY/ConPTY prompt, stdin response, resize, and completion;
- active POSIX shell, PowerShell, and CMD profiles where supported;
- Node TUI typecheck and Shell rendering tests.

Tests use deterministic synchronization rather than arbitrary sleeps whenever possible.

## Migration Sequence

1. Introduce the transport protocol and contract tests behind the existing manager.
2. Replace text-mode `Popen` with binary `PipeTransport` without changing model tools.
3. Add incremental decoding and terminal-control sanitization.
4. Add yield-based manager operations and the internal continuation API.
5. Add model-visible `WriteStdin` and hide `run_in_background`/`ShellOutput` from new schemas.
6. Add Unix PTY and Windows ConPTY transports.
7. Update lifecycle metadata and TUI background-transition behavior.
8. Add compatibility adapters, resume regression tests, and three-platform integration coverage.
9. Remove obsolete direct-`Popen` branches only after all transport contract tests pass.

Each step must preserve a working default PIPE path. PTY support is not allowed to destabilize
ordinary non-interactive commands.

## Acceptance Criteria

The design is complete when all of the following are true:

1. A flushed partial line appears in Shell lifecycle output before the child exits.
2. `Shell` defaults to pipes and uses PTY/ConPTY only with `tty: true`.
3. A command exceeding `yield_time_ms` returns a session ID and continues running.
4. Empty `WriteStdin` waits for incremental output without creating a new TUI card.
5. Non-empty `WriteStdin` can complete an interactive PTY/ConPTY prompt.
6. Linux, macOS, and Windows pass native transport integration tests.
7. Legacy Shell calls and old session histories remain usable.
8. The TUI shows one continuously updated Shell card across start, yield, polling, and completion.
9. Model-visible output obeys token budgets and stable formatting without wrapper tags.
10. Timeout, interruption, ownership, approval, and process-tree cleanup guarantees remain intact.


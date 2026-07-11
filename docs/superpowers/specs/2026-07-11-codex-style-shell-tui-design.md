# Codex-Style Shell TUI Design

**Date:** 2026-07-11

**Status:** Approved for implementation planning

## Goal

Make mycli's terminal UI represent shell execution with Codex-style command cells and background-terminal management while preserving the existing model-visible `Bash`, `BashOutput`, and `KillShell` tools.

The TUI must display process lifecycle state rather than treating a returned background `Bash` tool call as a completed command. Shell completion must update the TUI without causing an additional model request, while the main agent must continue receiving exactly one task notification and retain the ability to inspect output with `BashOutput`.

## Scope

This phase includes:

- Codex-style `Running` to `Ran` command cells.
- Incremental foreground and background shell output in the existing transcript.
- A persistent footer summary for active background terminals.
- `/ps` as a read-only transcript history block.
- `/stop` to terminate every background shell owned by the current mycli session.
- Typed shell lifecycle events from the Python runtime to the Node TUI.
- Bootstrap recovery for currently running background shells.
- Output coalescing, cursor metadata, terminal-state ordering, and bounded previews.

This phase does not include:

- Renaming tools to `exec_command` or `write_stdin`.
- A PTY or embedded interactive terminal.
- Arbitrary stdin delivery to running processes.
- A popup, selectable process list, or full-screen task view.
- Per-shell `/stop <shell_id>` interaction.
- Enabling parallel `Bash` tool calls.
- Persisting operating-system processes across mycli process shutdown.

## Current Gaps

The shell runtime already provides bounded output, session ownership, background timeout, process-group cleanup, terminal notifications, and compatibility through `ShellProcessRegistry`. The TUI currently loses most of that state:

- `MycliShellBash` only carries command, generic tool status, exit code, and output preview.
- A background `Bash` result can be shown as successful even while its process remains in `running_background`.
- Internal task-notification XML is hidden from the visible transcript, so it cannot update the original Bash command cell.
- Shell lifecycle details are recorded in runtime traces but are not fully projected into live TUI events.
- The current running hint implies that interrupting the active turn stops every running shell, which is incorrect for detached background shells.

## User Experience

### Foreground Execution

While a foreground command runs, one active transcript cell is updated in place:

```text
• Running uv run pytest -q (8s · esc to interrupt)
  └ tests/unit/tools/test_shell_session_manager.py ....
```

The elapsed time remains visible. `Esc` interrupts the active turn and the existing runtime interrupt token terminates the foreground process group.

When the command completes successfully, the same cell becomes:

```text
• Ran uv run pytest -q
  └ 1828 passed in 29.49s
```

The status bullet is green for exit code zero and red for a nonzero exit. The title remains `Ran`, matching Codex's command-cell grammar. Nonzero exit, timeout, interruption, and explicit termination are represented in the detail/output area.

### Background Execution

When `Bash` returns a `shell_id` for a process that remains alive, the transcript cell continues to show process state:

```text
• Running uv run dev
  └ Local: http://localhost:5173
```

The background cell does not show the active-turn interrupt hint. It remains `Running` across model turns until a terminal shell event arrives.

The footer shows the active owner-scoped count:

```text
2 background terminals running · /ps to view · /stop to close
```

The footer disappears when the count reaches zero.

### `/ps`

`/ps` inserts a read-only history block into the transcript:

```text
/ps

Background terminals

  • uv run dev
    ↳ Local: http://localhost:5173
  • uv run pytest -q
    ↳ 341 passed, still running...
```

At most 16 sessions are rendered. Additional sessions produce `... and N more running`. Each row includes a bounded command preview and recent bounded output chunks. The block does not open a popup or change the page layout.

### `/stop`

`/stop` terminates every running background shell owned by the current session and inserts:

```text
/stop

Stopping all background terminals.
```

Each affected command cell reaches its final state through manager terminal events. The footer is synchronized with the manager and disappears when no owner-scoped background shells remain. Other mycli sessions are unaffected.

## Architecture

The shell runtime and TUI communicate through a typed lifecycle stream:

```text
ShellSessionManager
  -> AgentRuntime shell lifecycle publisher
  -> NodeTuiGateway JSON-RPC notifications
  -> RuntimeShellState reducer
  -> BashExecutionComponent and footer
```

The main agent notification path remains independent:

```text
ShellSessionManager
  -> TaskNotification
  -> AgentRuntime steering queue
  -> model context at the next safe boundary
```

The TUI path never queues a user or steering message and never causes a model request. The agent path does not depend on the TUI being connected.

## Lifecycle Events

Add an immutable domain event with these conceptual fields:

```text
event_type
shell_id
owner_session_id
call_id
sequence
command_preview
background
process_state
terminal_state
exit_code
output_delta
next_cursor
output_chars
omitted_output_chars
cleanup_result
started_at
completed_at
```

The public TUI event names are:

- `shell.started`
- `shell.output`
- `shell.completed`
- `shell.removed`
- `shell.list.updated`

`shell.completed` covers successful completion, nonzero exit, timeout, interruption, and explicit kill through `terminal_state` and `exit_code`.

The command text exposed to the TUI is a bounded display preview. Diagnostic and trace projections continue to use command hash, command length, and command pattern rather than raw command text.

`ToolExecutionService` supplies the normalized tool `call_id` to shell tools through an internal runtime-only argument. `BashTool` passes that value through `ShellBackendRequest` and `ShellStartRequest`; it is stored on the session and copied into lifecycle events. The internal argument is never exposed in the model-visible tool schema, shell environment, command text, or persisted diagnostic payload.

## Event Delivery

Each shell session stores an optional lifecycle sink alongside its existing task-notification sink. The manager updates internal state under its lock and invokes external sinks outside the lock.

The runtime configures the shell lifecycle sink with the active session ID. The sink remains valid after the model turn ends so background output and completion can reach the TUI while the agent is idle.

`NodeTuiGateway` registers one owner-scoped listener through `TurnService` and `AgentRuntime`. Session resume or runtime rebind unregisters the previous owner listener before registering the new one. Gateway shutdown removes the listener. This prevents an old session from updating the current transcript or footer.

The Python-to-Node JSON-RPC writer must serialize writes with a dedicated lock because stdout drain, stderr drain, timeout, explicit stop, and active-turn threads can emit concurrently.

Sink failures are contained and do not affect process capture, cleanup, task notification, or model execution.

## Output Coalescing

Raw process output can be much faster than a TUI can redraw. Lifecycle output delivery therefore uses these limits:

- Emit at most one `shell.output` event per shell every 50 milliseconds.
- Limit each output delta to 4,096 characters.
- Include a monotonically increasing `sequence` and absolute `next_cursor`.
- Preserve the existing manager-level bounded output and output-file behavior.
- Keep only a bounded recent preview in TypeScript state.
- Redraw only when an event changes visible state.

The final terminal event flushes any pending output before `shell.completed` is delivered.

## TUI State Model

Extend `MycliShellBash` with:

```text
shellId
callId
background
processState
terminalState
exitCode
sequence
startedAt
completedAt
outputChars
omittedOutputChars
cleanupResult
```

Add an owner-scoped `backgroundShells` collection to runtime state. It contains only currently running background sessions and drives the footer summary and `/ps` data.

Transcript command cells are keyed by `call_id` when available and by `shell_id` after the process has been created. Reducers must support upsert when an output or terminal event arrives without a preceding start event.

Terminal state is monotonic. Once a cell is completed, failed, timed out, interrupted, or killed, later stale running/output events cannot return it to `Running`.

## Bootstrap And Recovery

The gateway bootstrap/status payload includes owner-scoped snapshots for active background shells. On TUI startup or session resume:

- Completed command history is reconstructed from the persisted transcript.
- Running background shells are reconstructed from manager snapshots.
- Snapshot rows are upserted by `shell_id`.
- A terminal event can create and immediately finalize a missing command cell.

OS processes are not persisted. `AgentRuntime.close()` continues to terminate the current owner's running sessions.

## Main Agent Semantics

Foreground Bash results return directly through the normal tool result and require no asynchronous task notification.

Background Bash preserves both inspection styles:

- The main agent may call `BashOutput(shell_id)` at any time to inspect current state and incremental output.
- The shell sends exactly one `TaskNotification` when it reaches a terminal state.

The notification enters the steering queue and becomes model-visible at the next safe boundary. It carries the shell/task ID and terminal summary. The main agent may then call `BashOutput` if detailed output is needed.

TUI events do not consume tokens and do not automatically invoke the model.

## Error Handling

- Cross-session shell access remains `shell_session_forbidden` and produces no foreign TUI state.
- Missing shell IDs produce an error result without creating a running footer entry.
- Capacity exhaustion appears as a failed Bash command cell with `shell_capacity_exceeded`.
- Output cursor eviction is represented through omitted counts and a visible truncation marker.
- JSON-RPC delivery failure does not suppress the main-agent task notification.
- Duplicate events are ignored using `shell_id + sequence`.
- Terminal events take precedence over stale output or running events.
- `/stop` is idempotent when no background terminals are running.

## Testing

### Python Unit Tests

- Lifecycle start, output, and terminal ordering.
- Exactly one terminal lifecycle event and exactly one task notification.
- Output coalescing interval and delta budget.
- Final output flush before terminal delivery.
- Cross-session event isolation.
- Concurrent JSON-RPC writer serialization.
- `/ps` and `/stop` owner scoping.

### TypeScript Unit And Snapshot Tests

- `Running` to `Ran` state transition.
- Background tool result remains `Running` while the process is alive.
- Terminal-state monotonicity under out-of-order events.
- Footer count and singular/plural text.
- `/ps` empty, one-process, multiline-output, long-command, and more-than-16 snapshots.
- `/stop` confirmation and footer removal.
- Output truncation and expanded/collapsed command cells.
- Bootstrap recovery from active shell snapshots.

### Integration Tests

- Start two real background processes and verify the footer count.
- Verify `/ps` renders both sessions and bounded recent output.
- Execute `/stop` and verify both process groups terminate.
- Verify each command cell reaches a terminal state.
- Verify the main agent receives one task notification per shell.
- Verify no additional model request is made solely for a TUI update.

## Acceptance Criteria

- Foreground and background commands use Codex-style `Running` and `Ran` transcript cells.
- A returned background Bash tool call remains visually running until the process terminates.
- Active background count is visible in the footer with `/ps` and `/stop` hints.
- `/ps` renders a read-only transcript block and does not open another view.
- `/stop` terminates all background shells owned by the current session only.
- Background completion updates the TUI without a model request.
- The main agent receives exactly one terminal task notification and can still call `BashOutput`.
- Output events are bounded, coalesced, ordered, and safe under concurrent stream threads.
- Existing model-visible tool names and arguments remain unchanged.
- Existing shell runtime, TUI, ruff, mypy, Python tests, and TypeScript tests pass.

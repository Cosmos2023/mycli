# Shell Session Runtime Design

## Objective

Make mycli's shell execution correct, bounded, and session-aware while preserving the existing model-visible `Bash`, `BashOutput`, and `KillShell` tools. The first implementation phase fixes current background-shell defects. It does not rename tools, add PTY interaction, or enable parallel Bash calls.

## Current Problems

- `BashOutput` stores incremental output in `raw_payload["output"]`, but the model-visible formatter does not render it.
- Background `timeout_seconds` is diagnostic metadata only; no runtime deadline terminates the process.
- Background output is retained in an unbounded `list[str]`.
- Background processes do not start in their own process group, so `KillShell` may leave descendants running.
- The global registry has no session ownership, capacity limit, or pruning policy.
- Foreground and background execution use different output, termination, and lifecycle behavior.

## Compatibility Boundary

The following external behavior remains available during the migration:

- `Bash(command, timeout, cwd, run_in_background)`
- `BashOutput(shell_id)`
- `KillShell(shell_id)`
- CLI background-shell inspection
- doctor shell-process and background-job diagnostics
- background `TaskNotification` delivery and persisted output files
- existing approval, hook, workspace-boundary, and environment-policy behavior

`run_in_background` remains supported. A later phase may add `yield_time_ms` and map `run_in_background=true` to an immediate yield, but that is outside the first implementation phase.

## Architecture

Introduce a session-aware `ShellSessionManager` behind the existing `ShellBackend` boundary.

```text
Bash ─────────┐
BashOutput ───┼──> ShellSessionManager ──> local subprocess / process group
KillShell ────┘             │
                            ├── bounded output buffer
                            ├── timeout watcher
                            ├── lifecycle snapshot
                            └── task notification
```

The manager owns process lifecycle. Tools translate model arguments into manager requests and translate manager snapshots into `ToolResult`; they do not manipulate `subprocess.Popen` directly.

### Shell Session

Each session records:

- stable `shell_id`
- owning mycli `session_id`
- command hash, command length, and approved command pattern
- cwd and timeout deadline
- process handle and process-group identity
- start, last-observed, and terminal timestamps
- terminal state, exit code, and cleanup result
- bounded output buffer and monotonic output cursor
- optional output file and notification sink

Raw commands remain internal and are excluded from diagnostics and model-visible metadata.

### Output Buffer

Use a bounded head-tail buffer rather than an unbounded list. The buffer keeps a stable prefix and the most recent suffix while tracking omitted character or byte counts.

Polling uses a monotonic cursor. If old incremental content has been evicted, the response explicitly reports that omission instead of silently returning incomplete output.

The model-visible result format for both `Bash` and `BashOutput` includes:

```text
Shell ID: ...              # only for session-backed execution
Status: running|completed|failed|timed_out|killed
Wall time: ... seconds
Exit code: ...             # when available
Output:
...
```

The formatter applies its own hard model-context budget. Raw diagnostic metadata does not duplicate `output`, `stdout`, and `stderr` unless a consumer explicitly requires those fields.

### Timeout And Termination

All local shell processes start in a separate process group on POSIX.

Timeout and explicit termination follow one cleanup path:

1. Send `SIGINT` for user interruption when appropriate.
2. Send `SIGTERM` and wait for a bounded grace period.
3. Send `SIGKILL` to the process group if it remains alive.
4. Record the final cleanup result and emit at most one task notification.

The timeout watcher is manager-owned, so a background process is terminated even when the model never calls `BashOutput` again.

### Ownership And Retention

Shell lookup, polling, and termination require the owning mycli session ID. The manager rejects cross-session access.

The manager has a fixed capacity. It prunes old completed sessions first and never silently discards a recently used running session. Shutdown terminates remaining owned processes.

## Data Flow

### Foreground Bash

1. Existing safety, approval, hook, cwd, and environment checks run.
2. `Bash` submits a start request to the manager.
3. The manager starts the process and waits for foreground completion or interruption.
4. The manager returns a typed final snapshot.
5. `ToolResultFormatter` renders one bounded transcript result.

### Background Bash

1. The same pre-execution checks run.
2. The manager starts and registers the session before returning.
3. `Bash` returns `shell_id`, running state, and task metadata.
4. A watcher drains output, enforces timeout, persists output, and emits terminal notification.

### BashOutput

1. Resolve the session by owner and `shell_id`.
2. Return output since the supplied or stored cursor plus current status.
3. Render the actual incremental output into the model transcript.

### KillShell

1. Resolve the owned session.
2. Run process-group termination.
3. Return the terminal snapshot and cleanup result.

## Error Handling

Stable error kinds cover missing IDs, unknown sessions, cross-session access, invalid state, timeout, interruption, spawn failure, and termination failure. Every started tool call still receives one terminal or running result suitable for transcript replay.

Output-file failures do not crash the drain thread. They are recorded as lifecycle metadata while in-memory capture and process cleanup continue.

## Concurrency

The manager is thread-safe because background drainers, timeout watchers, CLI inspection, and tool calls access shared sessions concurrently.

`Bash` remains `supports_parallel_tool_calls=False` in this phase. Enabling it requires a separate design for per-call approval state and ordering around workspace mutations. `BashOutput` may remain read-only from the approval perspective but should not be marked parallel until cursor updates are atomic.

## Testing Strategy

Implementation follows test-driven development. Required behavioral tests include:

- `BashOutput` transcript contains incremental output.
- background timeout terminates the process without polling.
- terminating a shell kills descendants in its process group.
- output retention remains below the configured hard limit.
- polling reports omitted output when a cursor falls behind eviction.
- completed sessions are pruned before running sessions.
- cross-session poll and kill requests are rejected.
- exactly one task notification is emitted for completion, timeout, and kill.
- existing Bash, CLI inspection, doctor diagnostics, hooks, and approval tests remain green.

## Rollout

1. Land the existing DeepSeek parallel-tool capability change separately.
2. Add failing tests for current shell defects.
3. Implement the bounded manager while preserving existing tool schemas.
4. Migrate CLI, doctor, and task notifications to manager projections.
5. After compatibility tests pass, consider a separate `yield_time_ms` and PTY design.

## Non-Goals

- Renaming tools to `exec_command` and `write_stdin`.
- Remote exec-server support.
- Windows PTY parity.
- Interactive stdin or terminal resizing.
- Parallel Bash execution.
- Replacing the existing approval or sandbox policy in this phase.

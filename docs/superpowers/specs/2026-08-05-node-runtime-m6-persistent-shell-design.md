# Node Runtime M6 Persistent Shell Design

**Date:** 2026-08-05

**Status:** Approved for implementation planning

## Goal

Give the Node runtime the complete production persistent-shell capability already available in the
Python runtime. A Node-owned agent turn must be able to execute ordinary commands, yield a running
process without restarting it, interact with PTY/ConPTY sessions, observe bounded incremental
output, manage background terminals, and terminate the complete process tree while preserving
approval, sandbox, recovery, and TUI contracts.

M6 is complete only when the Node backend can execute a real `Shell -> yield -> WriteStdin ->
completion` provider turn without starting Python and the native lifecycle suites pass on macOS,
Linux, and Windows.

## Scope

M6 includes:

- non-TTY pipe execution through `node:child_process`;
- Unix PTY and Windows ConPTY through `node-pty`;
- `Shell` and `WriteStdin` model tools;
- hidden `Bash`, `ShellOutput`, `BashOutput`, and `KillShell` compatibility routes;
- foreground completion, automatic yield, legacy immediate background execution, polling, input,
  resize, interrupt, timeout, targeted termination, owner termination, and backend cleanup;
- command policy, one-time/session/persistent approval, and exactly-once spawn coordination;
- read-only, workspace-write, and danger-full-access process sandbox profiles;
- normalized shell lifecycle events, bounded transcript persistence, background-terminal TUI state,
  and session-switch isolation;
- deterministic Python/Node parity, native platform tests, packaging verification, and rollout docs.

M6 does not include MCP, plugins, hooks, skills, subagents, Anthropic, general management commands,
or Python retirement. It does not attempt to reconstruct or reattach an OS process after the mycli
process has ended.

## Design Principles

1. **One process, one identity.** Yielding changes state; it never launches or migrates a process.
2. **Backend-owned lifetime.** Process handles outlive provider steps and individual turn objects.
3. **Explicit ownership.** Every operation carries the owning mycli session and cannot cross it.
4. **Policy before side effect.** Approval, sandbox, cwd, environment, and shell resolution finish
   before spawn.
5. **Fail closed.** A requested PTY, required sandbox, or ambiguous approval never silently degrades.
6. **Bound every stream.** Output, previews, events, diagnostics, and model responses have independent
   limits.
7. **Persist facts, not handles.** Transcript state may survive restart; live OS handles do not.
8. **Transport details stay private.** Runtime, provider, gateway, and TUI consume stable shell
   contracts rather than `node-pty` or `ChildProcess` APIs.

## Architecture

```text
Provider tool call
      |
      v
NodeTurnRuntime ---- approval/effect coordinator ---- execpolicy/rule store
      |
      v
ToolRouter ---- Shell / WriteStdin / compatibility adapters
      |
      v
ShellSessionManager ---- ShellLifecycleBus ---- storage projector
      |                         |
      |                         +---- active gateway generation ---- TUI
      |
      +---- PipeTransport (`child_process`)
      +---- NodePtyTransport (`node-pty`: Unix PTY / Windows ConPTY)
      +---- platform sandbox and process-tree controller
```

### Package Boundaries

`@mycli/tools` owns the transport interfaces, pipe and PTY adapters, session manager, output
buffers/sanitizer, process controller, shell tool definitions, command analysis, and tool-result
projection. These are reusable runtime capabilities and contain no gateway or TUI behavior.

`@mycli/config` owns loading and atomically writing user execpolicy rules. It never executes a
command and never accepts a preformatted rule string from a provider or UI.

`@mycli/runtime` owns policy suspension, durable effect claims, approval continuation, and the
explicit tool execution context. `ToolExecutionOptions` gains immutable owner session, call,
generation, and lifecycle publication context alongside the abort signal. The approval continuation
path supplies the same context as ordinary tool execution.

`@mycli/contracts` owns typed shell lifecycle payloads and gateway schemas. Provider-specific schema
projection remains in the provider package and must preserve strict Responses compatibility for
optional tool arguments.

The app composition root creates one `ShellSessionManager` and lifecycle bus per Node backend. The
manager is shared by runtimes created for different sessions and keys every handle by owner session.
Gateway close drains the manager before closing storage. Session switching changes the active event
subscription but does not destroy another session's running process.

The existing TUI remains a consumer. It continues to merge shell events into one card and use the
existing background list, footer count, `/ps`, and `/stop` surfaces.

## Model Tool Contract

### `Shell`

```json
{
  "command": "npm test",
  "cwd": "/workspace",
  "tty": false,
  "yield_time_ms": 10000,
  "max_output_tokens": 10000,
  "prefix_rule": ["npm", "test"]
}
```

`command` is required. `cwd` defaults to the workspace root. `tty` defaults to false.
`yield_time_ms` defaults to 10000 and is clamped to 250-30000 ms. `max_output_tokens` defaults to
10000 and remains subject to the runtime cap. `prefix_rule` is optional policy metadata and is never
executed.

The new provider schema omits `run_in_background` and user-controlled process timeout. The runtime
retains an absolute configured timeout. Hidden legacy calls may still supply their old fields.

The canonical manifest retains logical optionality. The strict Responses projection includes every
property name in `required` and represents optional values as nullable, then normalizes null/omission
to the defaults above before canonical validation. Chat Completions receives the same logical tool
contract. Contract fixtures cover both projections so M6 cannot reintroduce an
`invalid_function_parameters` failure for an omitted optional property.

### `WriteStdin`

```json
{
  "session_id": "a1b2c3d4",
  "chars": "",
  "yield_time_ms": 250,
  "max_output_tokens": 10000
}
```

An empty `chars` value waits for new output or terminal state without writing. Its wait is clamped
to 5000-300000 ms. Non-empty input is written to PTY/ConPTY and waits 250-30000 ms. Pipe stdin is
closed at launch and rejects non-empty input. `\u0003` maps to interrupt for either transport.

Interactions for one shell are serialized. Every response advances only the model cursor and uses
the same stable output shape as `Shell`, including chunk ID, wall time, running/exit state, original
token count when truncated, and bounded live/final output.

### Compatibility Routes

Only `Shell` and `WriteStdin` are advertised to new provider requests. The router can execute hidden
adapters not present in provider exposure:

- `Bash` maps legacy foreground/background and timeout arguments into `Shell`;
- `ShellOutput` and `BashOutput` perform an immediate legacy poll;
- `KillShell` terminates one owner-scoped shell;
- legacy `shell_id` and `bash_id` map to `WriteStdin.session_id`.

Old transcript, approval, hook, and replay data remains readable without migration.

## Transport Contract

The manager depends on a process-oriented interface rather than native implementation classes:

```ts
interface ShellTransport {
  readonly kind: "pipe" | "unix_pty" | "windows_conpty";
  readonly tty: boolean;
  readonly pid: number;
  onOutput(listener: (chunk: ShellOutputChunk) => void): Disposable;
  onExit(listener: (result: ShellExit) => void): Disposable;
  write(data: Uint8Array): Promise<void>;
  resize(rows: number, columns: number): Promise<void>;
  interrupt(): Promise<ProcessCleanupResult>;
  terminate(): Promise<ProcessCleanupResult>;
  close(): Promise<void>;
}
```

The concrete implementation may receive bytes or decoded text from its native API. The adapter
normalizes both into ordered chunks and records whether decoding replacement occurred. Consumers
never depend on `node-pty` event types.

### Pipe Transport

Pipe execution uses `spawn` with argv, cwd, environment, and sandbox wrapper already resolved. It
closes stdin at launch, reads stdout and stderr concurrently as buffers, and assigns one monotonic
arrival sequence when a chunk is published. Stdout and stderr retain separate bounded buffers plus
one ordered combined buffer.

Pipe commands run in a controllable process group or platform process container. Interrupt and
termination target the complete tree, not only the immediate child.

### PTY/ConPTY Transport

`node-pty` is loaded only when `tty: true`; pipe tests and startup do not import the native addon.
The adapter supplies initial rows/columns, combined terminal output, input, resize, exit status, and
platform-native termination. A requested PTY that cannot load or spawn fails with a typed error and
never falls back to pipe.

M6 pins `node-pty@1.2.0-beta.15` exactly. On 2026-08-05, isolated Node 24.14.1/macOS ARM64 testing
showed that stable `1.1.0` installed `spawn-helper` as non-executable and failed with
`posix_spawnp failed`; the pinned beta installed correct permissions and passed a real PTY smoke.
This prerelease pin is allowed only behind the M6 preview backend and must pass Node 22.19/24 native
lanes and packed-install smoke before release. There is no application-time chmod or pipe fallback.

## Session State And Lifecycle

The manager owns these logical states:

```text
starting
  -> running_foreground
  -> running_background
  -> completed | failed | timed_out | interrupted | killed
```

Capacity is reserved before spawn so concurrent starts cannot exceed the configured limit. Spawn
failure releases capacity and never registers a session.

After start, the manager emits `shell.started`, begins output and timeout watchers, and waits for
exit, abort, or the initial yield deadline. An unfinished foreground process atomically becomes
background. Completion racing the deadline wins over yield. The transition does not reset cursors
or create another transcript block.

An absolute process timeout begins at spawn and is unaffected by polls or input. A per-session lock
serializes input, poll, resize, and termination. Model and lifecycle consumers have separate cursors;
cursor eviction is explicit and reports omitted character counts.

Terminal completion follows this order:

1. observe the process exit or conclusive cleanup result;
2. drain and sanitize remaining output;
3. publish the final coalesced `shell.output`;
4. persist terminal metadata;
5. publish exactly one `shell.completed`;
6. publish `shell.list.updated` when the active background count changed.

Completed sessions remain readable idempotently until bounded eviction. Eviction never discards a
live process without attempting termination and recording the observed result.

## Lifecycle Events, Gateway, And TUI

The stable event names remain:

```text
shell.started
shell.output
shell.completed
shell.list.updated
shell.removed
```

Events include shell ID, owner session, call ID, sequence, bounded command preview, background and
process state, transport, tty/yield flags, terminal state, exit code, output delta/cursors/counts,
cleanup result, timestamps, shell profile, and owner background count.

The lifecycle bus is asynchronous so a slow renderer cannot block process readers. Output is
coalesced initially at 50 ms with a 4096-character event cap. A storage projector commits bounded
shell transcript state before terminal/list publication. Live process handles, raw bytes, stdin,
private environment, and full executable paths are never persisted.

The gateway publishes only events matching its active session and generation. Events from a prior
generation may update durable state but cannot mutate the current TUI. When switching back, bootstrap
reconstructs the shell card and current background list from manager snapshots plus persisted
history.

Empty `WriteStdin` polls do not create a separate TUI card. Non-empty input updates the originating
card but does not echo input text. Terminal control sequences cannot reach the renderer.

## Output Processing And Bounds

Pipe streams use incremental decoding so split UTF-8 code points do not produce duplicate
replacement characters. PTY text is normalized incrementally across event boundaries. Processing
then:

- normalizes CRLF and carriage-return progress updates into stable append-only text;
- handles backspace conservatively within the current line;
- removes SGR, OSC, title, clipboard, alternate-screen, and unsupported cursor-control sequences;
- preserves ordinary Unicode and line breaks;
- tracks replacement, byte/character, truncation, and omission counts.

The retained process buffer defaults to the Python-compatible 1 MiB character cap and uses stable
head/tail eviction. Per-response token budgeting truncates only the returned model view, never the
underlying retained buffer or lifecycle cursor.

## Approval And Persistent Rules

Shell command analysis resolves the active shell profile, parses executable segments, and combines
built-in safety with user/project execpolicy. Explicit deny stops immediately. Eligible allow rules
and known-safe commands run. Unknown high-risk segments suspend before spawn.

Shell approval can expose:

1. `approve_once`;
2. `reject`;
3. `allow_session`;
4. `always_allow`, only with a validated persistent proposal.

`prefix_rule` validation requires a bounded non-empty string array that is an exact prefix of the
segment awaiting approval. It rejects complex/cross-segment syntax, explicit ask/deny policy,
sensitive values, redacted values, broad interpreters/shells/escalation, and destructive command
families.

`always_allow` writes only `~/.mycli/rules/default.rules`. The writer uses a dedicated advisory lock,
private directory/file permissions, parse-preserving JSON token serialization, a unique temporary
file, fsync where supported, and atomic replace. It deduplicates identical rules. After publication,
the runtime reloads policy before resuming the approved call.

Failure to validate, lock, write, parse, or refresh does not execute the shell or clear the pending
decision. If persistence succeeded but refresh failed, the error says so without exposing the rule.

The M5 effect checkpoint sequence remains authoritative: persist approval, claim the effect with an
argument fingerprint, spawn once, persist the bounded tool result, and complete the effect. Startup
never replays an executing effect without a durable result; it reports `effect_outcome_unknown`.

## Sandbox And Process Cleanup

The active permission profile produces one immutable sandbox launch specification before transport
creation:

- macOS workspace-write/read-only uses Seatbelt through the fixed `sandbox-exec` protocol;
- Linux uses Bubblewrap with parent-death, network, read, write, and protected-root bindings;
- Windows uses the packaged restricted-token helper and kill-on-close process container;
- danger-full-access is the only direct-host execution mode.

Missing or invalid isolation in a restricted profile returns `sandbox_unavailable`. The launch path
does not weaken permissions to make a command run. Cwd, writable roots, denied roots, repository
metadata, environment, shell executable, and wrapper argv are canonicalized before spawn.

Interrupt first uses the transport-native mechanism, then bounded escalation. Termination verifies
the process tree rather than assuming that closing a PTY killed descendants. POSIX uses a dedicated
process group; Windows uses the helper/container plus an explicit tree fallback. Linux preserves
`--die-with-parent`. Normal shutdown, signal handling, timeout, targeted kill, owner stop, capacity
eviction, and gateway failure all converge on the same idempotent cleanup path.

An inconclusive cleanup is observable and never reported as success. The manager keeps sufficient
state to retry cleanup while the backend is alive.

## Error Contract

Stable structured errors include:

| Error | Meaning |
| --- | --- |
| `invalid_command` | Shell command or arguments are invalid |
| `invalid_cwd` | Working directory is invalid or outside policy |
| `shell_resolution_failed` | Active shell profile cannot be resolved |
| `shell_spawn_failed` | Process creation failed |
| `pty_unavailable` | Unix PTY/native addon is unavailable |
| `conpty_unavailable` | Windows ConPTY/native addon is unavailable |
| `sandbox_unavailable` | Required process isolation cannot be established |
| `shell_capacity_exceeded` | No bounded session slot is available |
| `shell_not_found` | Shell ID is unknown or already evicted |
| `shell_session_forbidden` | Shell belongs to another owner session |
| `stdin_closed` | Non-empty input targeted a pipe session |
| `shell_already_completed` | Operation requires a live process |
| `shell_write_failed` | PTY/ConPTY input failed while process remained live |
| `shell_resize_failed` | Terminal resize failed |
| `shell_cleanup_failed` | Process-tree cleanup was inconclusive |
| `timeout` | Absolute process lifetime expired |
| `interrupted` | User/runtime interruption completed |
| `effect_outcome_unknown` | Recovery cannot prove whether claimed spawn completed |

Errors include bounded context only. Full command text, stdin, private paths, environment values,
native stack traces, and raw provider arguments are excluded.

## Persistence And Restart

Persisted shell transcript state contains bounded command preview/output, state, exit code, timing,
transport, tty/yield flags, shell ID, output/omission counts, decode replacements, and cleanup result.
It does not contain a live PID as a recoverable capability.

On normal backend shutdown, all owned live processes are terminated before storage closes. On a
later process start, historical cards remain visible. A historical nonterminal shell without a live
manager handle is projected as stale/interrupted without inventing an exit code; `WriteStdin`
returns `shell_not_found`. No restart path scans arbitrary OS processes or reattaches by PID.

## Verification Strategy

Implementation follows test-driven development.

### Unit And Contract Tests

- run one shared transport contract against fake, pipe, and platform PTY implementations;
- cover partial output, large chunks, split encoding, stdout/stderr ordering, input, resize, exit,
  interrupt, termination, close, and process-tree cleanup;
- cover completion/yield races, output cursors, eviction, coalescing, timeouts, capacity, owner
  isolation, interaction serialization, and final event ordering;
- cover command parsing, rule precedence, proposal validation, atomic writer failures, runtime refresh,
  session allowance, and exactly-once approval recovery;
- cover every sandbox profile and missing-wrapper fail-closed path with injectable platform probes;
- cover stable model-output formatting, token truncation, redaction, and terminal-control filtering.

### Runtime, Gateway, And TUI Tests

- fake-provider `Shell -> completion` and `Shell -> yield -> WriteStdin -> completion` loops;
- approval suspension/resume without duplicate spawn, including restart ambiguity;
- lifecycle contract validation, persistence-before-publication, active-generation filtering, and
  session switch away/back;
- `/ps`, `/stop`, footer count, one-card output merge, hidden empty polls, and replay equivalence;
- backend close, CLI signal, timeout, targeted kill, and failed-gateway orphan cleanup.

### Parity And Native Matrix

Python/Node fixtures compare tool schemas, normalized lifecycle events, model output, error kinds,
ownership, approval, sandbox decisions, and restart projection. Unstable IDs/timestamps are
normalized only for comparison.

`npm run test:m6` builds the workspace, runs the Node M6 integration suite, and runs Python/Node
parity. It joins the full `npm test`, `npm run typecheck`, `npm run lint`,
`npm run contracts:check`, `npm run test:m5`, and packed CLI smoke gates.

CI runs Node 22.19 and Node 24 on macOS, Linux, and Windows. Each platform must execute a real native
terminal lane covering prompt/input, resize, completion, interrupt, timeout, and process-tree cleanup.
Mock-only success is insufficient. Packed installation must load the native addon and start a PTY.

After all offline gates pass, an authorized live provider smoke may run in a disposable home and
workspace with minimal tokens, zero retries, strict timeout, and no secret-bearing output. Service
unavailability is recorded once and not retried. The smoke must prove Node-owned shell tool calls and
`python_started=false`.

## Rollout And Rollback

The Node backend remains explicitly selected during M6. A shell failure never reruns the turn or
command through Python. Rollback is operator-controlled before a later turn, after pending approval
has been resolved or rejected and live Node background processes have been stopped.

Documentation covers native dependency installation, platform sandbox prerequisites, supported
shell profiles, diagnostics, M6 verification, and rollback to `python-sidecar`. M6 is not promoted
until all native release lanes are green.

## Implementation Sequence

1. Add strict shell contracts, fake transport tests, output bounds, and lifecycle types.
2. Add pipe transport, platform cleanup, session manager, and non-TTY integration tests.
3. Add `Shell`/`WriteStdin` adapters, hidden compatibility routes, runtime context, persistence, and
   gateway/TUI lifecycle wiring.
4. Add command policy, Shell approval choices, persistent rule storage, and effect recovery tests.
5. Add all sandbox launch protocols and fail-closed platform tests.
6. Add the pinned `node-pty` adapter, PTY/ConPTY input/resize/cleanup tests, and packed-install smoke.
7. Add M6 parity/live smoke, full native CI matrix, rollout documentation, and final regressions.

Each step keeps the default pipe path working. Native PTY support cannot weaken non-TTY execution or
security behavior.

## Acceptance Criteria

1. A flushed partial pipe line appears before process exit.
2. `Shell` defaults to pipe and uses PTY/ConPTY only for `tty: true`.
3. A command exceeding the initial wait returns one session ID and continues without restart.
4. Empty polling returns incremental output without creating another TUI block.
5. Non-empty input and resize work on Unix PTY and Windows ConPTY.
6. Model and lifecycle cursors remain independent under truncation and eviction.
7. Owner isolation prevents cross-session list, input, resize, and termination.
8. Approval and durable effect recovery cannot duplicate spawn.
9. Restricted sandbox profiles fail closed and remain effective for children and background lifetime.
10. Interrupt, timeout, targeted kill, owner stop, gateway close, and CLI exit clean process trees.
11. Historical Shell cards replay after restart without pretending live handles were restored.
12. macOS, Linux, and Windows pass real native lifecycle and packed-install tests on supported Node
    versions.
13. A bounded provider smoke completes a Node-only persistent-shell turn when service access is
    available.

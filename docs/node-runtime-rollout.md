# Node Runtime M6 Rollout

## Current Status

The Node runtime is an explicit preview backend for text turns, Node-owned session recovery,
the built-in file tools, and persistent shell execution. The default remains `python-sidecar`.
Do not promote Node to the default until the M6 offline gate and the Node 22.19 and Node 24
macOS, Linux, and Windows matrices pass for the release candidate.

Select the preview backend before starting a new turn:

```bash
mycli --runtime-backend=node
```

Use `--model <name>` and `--session <id>` with the same precedence and session semantics as the
existing CLI. One backend owns the complete turn, provider continuation, approval, and process
lifecycle. A failed Node operation is never retried through Python.

## Supported M6 Scope

- OpenAI Responses and OpenAI-compatible Chat Completions
- streamed text, reasoning, compaction, tool, approval, shell, and terminal events
- bounded runtime-owned retries and interruption, with no fixed provider-step or tool-call ceiling
- append-compatible SQLite conversation, history, rollout, state, summary, and idempotency records
- atomic session resume, durable queue state, one-time approval continuation, compaction, and memory
- Node-native `Read`, `Edit`, `Patch`, and `Write`
- model-visible `Shell` and `WriteStdin`, plus hidden compatibility routing for `Bash`,
  `ShellOutput`, `BashOutput`, and `KillShell`
- foreground pipe execution, foreground-to-background yield, explicit background execution,
  cursor-based output, PTY input, polling, resize, interrupt, targeted stop, and backend cleanup
- Unix PTY on macOS/Linux and ConPTY on Windows through `node-pty`
- owner-session isolation and durable shell lifecycle projection into the existing TUI transcript
- command approval with once, reject, session allowance, and validated persistent allowance choices
- fail-closed process sandbox enforcement for restricted permission profiles
- Python/Node deterministic parity fixtures and real native lifecycle tests

`LS`, `Glob`, and `Grep` remain retired. M6 does not support external writable roots, local images,
MCP, plugins, hooks, skills, subagents, or automatic background memory extraction in the Node
runtime. Unsupported capabilities fail explicitly and are never delegated to Python after a Node
turn starts.

## Native And Sandbox Prerequisites

The supported runtime floor is Node `22.19.0`; Node 24 is also covered. Install from the root
lockfile with `npm ci`. `@mycli/tools` pins `node-pty` exactly to `1.2.0-beta.15`: the stable
`1.1.0` package installed its macOS ARM64 `spawn-helper` without the executable bit, while the
pinned beta installed the helper correctly and passed the native PTY smoke. Do not loosen or
replace this pin without rerunning packed-install and native lifecycle tests on every supported OS.

When a prebuilt native binary is unavailable, the normal `node-gyp` build prerequisites apply:
Python, a C/C++ toolchain, and platform build tools (Xcode Command Line Tools on macOS, build
essentials on Linux, or Visual Studio Build Tools on Windows).

Restricted process execution also requires the platform isolation mechanism:

- macOS `read-only` and `workspace-write` require executable `/usr/bin/sandbox-exec`.
- Linux restricted profiles require executable `/usr/bin/bwrap` or `/bin/bwrap`.
- Windows restricted profiles require the packaged `mycli-windows-sandbox.exe` helper.
- `danger-full-access` runs directly as the current OS user and must be selected explicitly.

If a required wrapper/helper is missing, shell launch returns `sandbox_unavailable`; it does not
fall back to unsandboxed execution. A bad native PTY install also fails explicitly and does not
fall back to pipe transport for `tty: true`.

## Shell Operation

A long-running foreground `Shell` call yields one eight-character shell ID without restarting the
process or resetting its output cursor. `WriteStdin` sends input to PTY/ConPTY sessions; empty input
polls for incremental output. Completion, timeout, interrupt, and stop publish the same normalized
shell lifecycle used by the TUI and durable transcript.

The TUI surfaces background process control through:

- `/ps` to list active shells owned by the current session
- `/stop` to stop every active shell owned by the current session

Targeted stop remains available through the typed `shell.stop` gateway RPC and the hidden
`KillShell` compatibility route.

Session ownership is enforced at the manager boundary. A different conversation cannot observe,
write to, resize, interrupt, or stop another session's shell. Backend shutdown drains lifecycle
persistence and closes or terminates every owned live transport, including its process tree.

## Failure And Rollback

A failed Node turn reports its actual terminal error. mycli does not replay it through Python,
because that could duplicate a provider request, approval, file mutation, or process launch.

Resolve or reject any pending approval, and stop active background shells before switching
backends. Then use the operator-controlled rollback path before a later turn:

```bash
mycli --runtime-backend=python-sidecar --session <id>
```

Both backends read the shared SQLite schema. Historical shell transcript items remain readable,
but a live OS process is intentionally never reconstructed or reattached after a mycli restart.
Installing the prior release is also a valid rollback when no newer turn is running, awaiting
approval, or holding a live shell.

## Verification

Run the deterministic M6 gate and the previous milestone regression after a clean install:

```bash
npm run contracts:check
npm run typecheck
npm run lint
npm run test:m5
npm run test:m6
npm test
npm run smoke:package
```

`test:m6` builds the workspace, runs the real Node backend PTY approval/input/persistence
integration, exercises the fake-provider live-smoke contract, and runs the Python/Node shell parity
fixture. CI additionally runs native pipe/PTY lifecycle and cleanup tests with Node 22.19 and
Node 24 on macOS, Linux, and Windows.

Only after every offline gate passes, run the opt-in live smoke:

```bash
npm run smoke:m6
```

The smoke uses `gpt-5.5`, a configured non-official Responses-compatible endpoint, a disposable
home/workspace/database/session, zero retries, 64 output tokens per provider request, and one
30-second deadline. It saves workspace trust, selects full access, approves one shell launch,
verifies PTY yield and `WriteStdin` completion, closes the backend, and validates cleanup and
SQLite persistence without starting Python.

Missing credentials or an unavailable service produce exit `77`; success produces `0`; a completed
request that fails structural assertions produces `1`. Every path prints exactly one JSON line with
only protocol, status, lifecycle counts/booleans, transport enum, active-shell count, trust,
permission, persistence, cleanup, and `python_started` state.

The smoke never prints credentials, endpoint data, prompts, commands, stdin, provider output, raw
responses, shell output, hashes, database paths, workspace paths, or session paths. Do not retry an
unavailable paid-service request in the same verification run.

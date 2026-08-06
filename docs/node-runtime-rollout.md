# Node Runtime M7 Rollout

## Current Status

The Node runtime is an explicit preview backend for complete turns, Node-owned session recovery,
file and persistent-shell tools, Anthropic Messages, extensions, subagents, setup, management, and
doctor. The default remains `python-sidecar`. Do not promote Node to the default until the M7
offline, package, parity, live-smoke, and Node 22.19/24 platform matrices pass for the release
candidate.

Select the preview backend before starting a new turn:

```bash
mycli --runtime-backend=node
```

Use `--model <name>` and `--session <id>` with the same precedence and session semantics as the
existing CLI. One backend owns the complete turn, provider continuation, approval, and process
lifecycle. A failed Node operation is never retried through Python.

## Supported M7 Scope

- OpenAI Responses, OpenAI-compatible Chat Completions, and Anthropic Messages
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
- one stable `Skill` tool with bounded discovery and durable instruction injection
- local stdio and supported remote MCP discovery, tools, resources, cancellation, and cleanup
- configured command hooks with digest-bound approval, sandboxing, timeout, and output bounds
- process-isolated compiled ESM Plugin API v2 tools, hooks, commands, and migration diagnostics
- foreground/background subagents with frozen tool scopes, durable ownership, progress,
  interruption, recovery, and result collection
- provider-free Node setup and hooks/plugins/MCP/subagent management commands
- independent, read-only Node doctor collectors with shared human/JSON reports and redaction

`LS`, `Glob`, and `Grep` remain retired. M7 does not remove the Python backend, provide Python
plugin source compatibility, add a hosted plugin marketplace, or productize unrelated new
integrations. Unsupported capabilities fail explicitly and are never delegated to Python after a
Node turn starts.

Extension paths, formats, approvals, and management commands are documented in
[node-extensions.md](node-extensions.md). Plugin authors should use
[plugin-api-v2.md](plugin-api-v2.md); existing Python plugin owners should follow
[migration/python-plugins-to-v2.md](migration/python-plugins-to-v2.md).

## Management And Doctor

The CLI routes `setup`, `doctor`, `hooks`, `plugins`, `mcp`, and `subagents` before TTY checks,
backend selection, provider construction, or TUI import. `--json` serializes the same typed object
used by the human renderer. Invalid usage exits `2`; failed operations exit `1`; setup cancellation
exits `130`.

`mycli doctor` checks config/auth presence, read-only SQLite and storage layout, logs/traces and
obvious redaction failures, Node/package/gateway contracts, the built-in tool manifest,
sandbox/process support, hooks, plugins, Python migration state, skills, subagents, and MCP. One
collector failure does not stop later collectors. Warnings exit `0`; failed checks exit `1`.

Doctor never calls a model provider or repairs local state. An extension check may initialize an
enabled MCP client or plugin worker only through its normal management lifecycle, and must close it
before returning. Reports exclude credentials, headers, commands/arguments, environment values,
prompts, provider payloads, raw extension output, and private file contents.

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

Run the deterministic M7 gate and the previous milestone regressions after a clean install:

```bash
npm run contracts:check
npm run typecheck
npm run lint
npm run test:m6
npm test
npm run smoke:package
```

The M7 tests additionally cover Anthropic serialization, extension discovery and lifecycle,
configured hooks, Plugin API v2 protocol/process isolation, subagent ownership, provider-free
management, doctor aggregation/redaction, and no-Python Node startup. CI runs process-sensitive
pipe/PTY/MCP/plugin/subagent cleanup tests with Node 22.19 and Node 24 on macOS, Linux, and Windows.

Only after every offline gate passes, run the opt-in live smoke selected for the release candidate.
The existing M6 shell smoke remains available during M7 development:

```bash
npm run smoke:m6
```

The smoke uses the configured model, a disposable
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

M8 is the backend-retirement boundary. M7 must remain rollbackable to `python-sidecar`; it does not
delete Python production code or silently change the default backend.

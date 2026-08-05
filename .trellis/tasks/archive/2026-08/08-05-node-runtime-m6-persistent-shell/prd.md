# M6 Persistent Shell

## Goal

Port the production persistent-shell capability from the Python runtime to the Node runtime so a
Node-owned agent turn can start foreground or background commands, yield without losing the
process, exchange terminal input, observe bounded incremental output, interrupt or stop the
process tree, and preserve the existing approval and sandbox boundaries.

## What I Already Know

- M5 is complete and archived; Node now owns recoverable session, queue, approval, compaction,
  continuation, memory, and workspace-trust state.
- The approved rewrite roadmap defines M6 as PTY/ConPTY transport through `node-pty`, background
  terminals, stdin forwarding, resize, interrupt, process-tree cleanup, and persistent-process
  sandbox validation.
- The Python runtime already exposes a transport-neutral `ShellSessionManager` with pipe, Unix PTY,
  and Windows ConPTY adapters plus `Shell`, `WriteStdin`, and `KillShell` tools.
- The TUI already understands shell lifecycle events and background-terminal surfaces, so M6 should
  feed the existing normalized event contract instead of inventing a second UI model.
- The Node tool manifest currently exposes only `Read`, `Edit`, `Patch`, and `Write`; no process tool
  is exposed by the Node backend.
- Node 22.19 remains the minimum supported runtime; the developer machine currently uses Node 24.

## Requirements

- Implement a transport-neutral Node shell session owner with bounded output and cursor-based reads.
- Support non-TTY pipe execution and optional PTY/ConPTY execution through `node-pty`.
- Support foreground completion, automatic yield to a persistent session, explicit background
  execution, stdin forwarding, empty polling, terminal resize, interrupt, targeted kill, and global
  cleanup on runtime shutdown.
- Preserve owner-session isolation: one conversation cannot observe or control another
  conversation's shell sessions.
- Expose `Shell` and `WriteStdin` through the Node tool manifest and provider loop. Register
  `KillShell` and the other legacy names as hidden router compatibility behavior, and carry all
  shell operations through approval, normalized runtime events, persistence, and the TUI.
- Apply the active permission profile and fail closed when a required sandbox wrapper is unavailable.
- Keep command text and retained output bounded and redacted in diagnostics, events, and errors.
- Do not silently fall back to Python when Node shell execution fails.
- Keep Python/Node parity fixtures deterministic; use real processes only in bounded integration and
  platform lifecycle tests.

## Acceptance Criteria

- [ ] A foreground pipe command streams output and returns its exit code.
- [ ] A long-running command yields a shell ID and later resumes through `WriteStdin` or polling.
- [ ] `tty: true` supports interactive input and resize on Unix PTY and Windows ConPTY.
- [ ] Background commands update the existing TUI process count and `/ps`/`/stop` surfaces.
- [ ] Abort, timeout, targeted kill, gateway close, and normal CLI exit clean the entire owned
      process tree without orphaning children.
- [ ] Shell IDs and process control are scoped to the owning session.
- [ ] Approval is completed before spawn, and retry/recovery cannot duplicate a process launch.
- [ ] `read-only`, `workspace-write`, and `danger-full-access` profiles behave consistently with the
      Python sandbox contract and fail closed where isolation is unavailable.
- [ ] Output retention, cursor eviction, invalid UTF-8 replacement, and lifecycle event ordering are
      covered by unit and integration tests.
- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run contracts:check`, and an M6-specific
      parity suite pass.
- [ ] macOS, Linux, and Windows lifecycle lanes cover platform-sensitive transport and cleanup paths.
- [ ] Rollout, rollback, installation, and native dependency documentation are updated.

## Definition of Done

- Tests cover pure lifecycle logic, fake transports, real pipe/PTY smoke, gateway integration,
  provider-visible tool loops, sandbox failure, and shutdown cleanup.
- Type checking, lint, contracts, full Node tests, and the M6 Python/Node parity suite are green.
- No credential, full command, private path, or unbounded process output is persisted in diagnostics.
- The change remains behind explicit Node backend selection and includes rollback notes.

## Technical Approach

Use a contract-first port. Keep transport, process/session ownership, tool adapters, and runtime
composition separate. Place the reusable lifecycle and tool implementation under `@mycli/tools`,
compose one manager per Node backend, and bridge only normalized lifecycle events into the existing
runtime/TUI contract. Use `node-pty` behind a narrow adapter and retain a native Node pipe transport
for non-TTY commands and deterministic tests.

The architecture is confirmed as follows:

- `ShellTransport` isolates pipe and `node-pty` implementations.
- `ShellSessionManager` is backend-owned and outlives individual provider turns.
- Tool adapters validate and project data but do not own OS processes.
- Execution context carries the owner session, call identity, abort signal, and lifecycle sink
  explicitly; no mutable global callback is used.
- Existing normalized shell events remain the only TUI-facing contract.
- Live handles remain in memory and are terminated during backend shutdown; historical transcript
  state may survive restart, but processes are never falsely reconstructed or reattached.

The lifecycle and data flow are confirmed as follows:

- Approval and policy checks complete before the manager reserves and spawns a process.
- One process transitions atomically from foreground to yielded/background without restart or
  cursor reset.
- Pipe bytes and native PTY text are normalized through incremental decoding/sanitization, bounded,
  and consumed through separate model and lifecycle cursors.
- `WriteStdin` serializes interaction per shell, uses empty input as a poll, accepts non-empty input
  only for PTY/ConPTY, and maps the interrupt character to process interruption.
- Absolute timeout, terminal completion, final output flush, list updates, and shutdown cleanup are
  independent of provider-step and polling lifetimes.
- Resize remains an internal transport/manager capability rather than a new model-visible field.
- New tool exposure is limited to `Shell` and `WriteStdin`; legacy shell names remain compatibility
  routes only.

The security and failure design is confirmed as follows:

- Shell-aware command policy and execpolicy run before spawn; unknown high-risk commands suspend for
  approval, and explicit deny rules cannot be overridden.
- Shell approvals support once, reject, session allowance, and a persistent global allowance only
  when a model-supplied narrow prefix passes structural, sensitive-value, breadth, destructive, and
  policy-source validation.
- Global rule writes use locking, private permissions, parse-preserving serialization, atomic
  replacement, and immediate runtime refresh; partial failure keeps the call pending.
- The M5 durable effect claim occurs before process creation. Ambiguous recovery reports
  `effect_outcome_unknown` and never replays spawn.
- Read-only and workspace-write execution require their platform sandbox wrapper and fail closed
  when unavailable; danger-full-access remains an explicit direct-host mode.
- Owner-scoped process-tree cleanup is platform-specific and verified rather than inferred from a
  transport close call.
- Commands, stdin, private environment, absolute executable paths, raw terminal controls, and
  unbounded output are excluded from diagnostics and persistence.

## Decision (ADR-lite)

**Context:** M6 can either port the established transport-neutral Python contract, wire `node-pty`
directly into the app, or keep shell execution in the Python sidecar.

**Decision:** Port the complete established contract into focused Node modules and use `node-pty`
only behind a `ShellTransport` boundary. M6 ships pipe execution, PTY/ConPTY, background sessions,
stdin/poll/resize, approval, sandbox enforcement, lifecycle events, and process-tree cleanup as one
coherent milestone rather than exposing an interim reduced shell contract.

**Consequences:** This adds a native npm dependency and cross-platform CI work, but contains native
API differences, keeps process lifecycle testable with fake transports, avoids app-layer business
logic, and advances the Node-only retirement path.

## Open Questions

- None. Architecture, lifecycle, data flow, security, approvals, failure semantics, verification,
  dependency handling, and release gates are approved.

## Out of Scope

- MCP, plugins, hooks, subagents, setup/management commands, and Anthropic provider support (M7).
- Python production-code retirement or removal of the compatibility backend (M8).
- Persisting live OS processes across a full mycli process restart; recovery must mark prior live
  handles interrupted/stale rather than pretending an orphaned process can be reattached safely.
- A new terminal UI; M6 reuses the existing shell cards, background list, footer count, and commands.

## Technical Notes

- Rewrite roadmap: `docs/superpowers/specs/2026-08-03-mycli-node-runtime-rewrite-design.md`
- Existing shell contract: `docs/superpowers/specs/2026-07-17-codex-style-unified-shell-runtime-design.md`
- Existing approval contract: `docs/superpowers/specs/2026-07-17-codex-style-persistent-shell-approvals-design.md`
- Python reference: `src/mycli/tools/shell_session_manager.py`, `src/mycli/tools/shell_transport/`,
  `src/mycli/tools/bash.py`, `src/mycli/tools/write_stdin.py`, and `src/mycli/tools/kill_shell.py`
- Node composition: `packages/tools/src/`, `packages/runtime/src/node-turn-runtime.ts`, and
  `apps/mycli/src/node-runtime/node-backend.ts`
- TUI projection: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Dependency research verified `node-pty@1.2.0-beta.15` on Node 24.14.1/macOS ARM64 after the stable
  `1.1.0` package failed because its `spawn-helper` was installed without executable permission.

## Research References

- [`research/existing-shell-contract.md`](research/existing-shell-contract.md) - current parity
  contract, Node gap, candidate implementation shapes, and principal risks.

# Existing Shell Contract And Node Gap

## Sources Inspected

- `docs/superpowers/specs/2026-08-03-mycli-node-runtime-rewrite-design.md`
- `docs/superpowers/specs/2026-07-17-codex-style-unified-shell-runtime-design.md`
- `docs/superpowers/specs/2026-07-17-codex-style-persistent-shell-approvals-design.md`
- `src/mycli/domain/runtime/shell_lifecycle.py`
- `src/mycli/tools/shell_session_manager.py`
- `src/mycli/tools/shell_transport/`
- `src/mycli/tools/bash.py`
- `src/mycli/tools/write_stdin.py`
- `src/mycli/tools/kill_shell.py`
- `src/mycli/tools/process_sandbox.py`
- `packages/tools/src/`
- `apps/mycli/src/node-runtime/node-backend.ts`
- `tui/mycli-shell/src/adapters/runtime-state.ts`

## Existing Contract

The Python runtime separates four responsibilities:

1. A transport protocol owns byte IO, exit observation, resize, interruption, and process-tree
   cleanup.
2. A session manager owns IDs, session isolation, background state, timeouts, output buffers,
   cursors, lifecycle events, and shutdown cleanup.
3. Tool adapters project `Shell`, `WriteStdin`, and `KillShell` arguments and results.
4. Runtime and TUI layers consume normalized events and never own the OS process directly.

The TUI already has compatible shell transcript, output merge, background terminal, footer, `/ps`,
and `/stop` behavior. The Node backend lacks only the process/tool/runtime producer side.

## Node Runtime Gap

- `@mycli/tools` has no process transport, manager, shell adapters, or shell manifest definitions.
- The Node backend creates file adapters per backend but has no long-lived process owner.
- The current approval policy recognizes only the file-tool manifest.
- Gateway close aborts the active turn but does not own a process registry to drain.
- The contracts package does not yet expose typed Node shell lifecycle payloads even though the TUI
  can normalize Python-originated shell events.
- No native dependency currently supplies Unix PTY or Windows ConPTY.

## Feasible Approaches

### A. Contract-first port in `@mycli/tools` (recommended)

Implement a narrow transport interface, pipe and `node-pty` adapters, a session manager, and tool
adapters in `@mycli/tools`. Compose one manager at the Node backend boundary and inject lifecycle
events into the runtime.

Advantages: mirrors proven Python boundaries, fake-transport tests remain deterministic, native API
differences stay localized, and M8 can remove Python without another shell redesign.

Costs: more modules and up-front contract work; requires explicit event and shutdown wiring.

### B. Direct `node-pty` integration in the app runtime

Create processes from `node-backend.ts` or `node-turn-runtime.ts` and expose thin tools around a map
of PTY handles.

Advantages: fewer initial files and fast happy-path progress.

Costs: couples provider turns, process ownership, native transport, and gateway shutdown; pipe tests
become awkward; sandbox and ownership rules are easy to duplicate. This conflicts with repository
layering guidance.

### C. Keep persistent shell in the Python sidecar

Route only shell tool calls to Python while Node continues to own the provider turn.

Advantages: reuses the mature Python implementation and avoids immediate native npm work.

Costs: adds a new cross-runtime streaming/process-control protocol, preserves Python as a production
dependency, complicates approval exactly-once behavior, and works against M8. This is suitable only
as rollback, not as the M6 target.

## Principal Risks

- `node-pty` is native and must be installed and exercised on each supported OS/architecture.
- Process-tree termination semantics differ across POSIX and Windows; transport close alone is not a
  sufficient cleanup contract.
- A yielded foreground process outlives the provider tool call, so the manager must outlive an
  individual `NodeTurnRuntime` and still be scoped to its backend/session owner.
- Approval recovery must never replay a spawn after the effect has been claimed.
- Persistent process state cannot truthfully survive an application crash; durable state should
  record interruption/staleness, while live handles remain in memory only.
- PTY streams merge stdout/stderr and may contain partial or invalid UTF-8 sequences; decoding and
  output retention must be incremental and bounded.
- Sandbox wrappers must be applied before spawn and remain effective for the full process lifetime,
  including children.

## Recommendation

Use Approach A and treat the existing Python shell semantics as the compatibility contract. Deliver
the full M6 scope together because PTY/ConPTY, input, resize, cleanup, approval, sandbox, and TUI
events share one lifecycle model; splitting them would create an interim tool contract that is
immediately replaced.

## `node-pty` Packaging Check (2026-08-05)

Registry metadata reported `1.1.0` as stable and `1.2.0-beta.15` as the current beta. Both were
installed in isolated temporary directories with a dedicated npm cache on macOS ARM64 under Node
24.14.1.

- `1.1.0` installed successfully, but its packaged macOS ARM64 `spawn-helper` had mode `0644`.
  Starting `/bin/sh` failed with `posix_spawnp failed`.
- Applying executable permission to that temporary helper made the same PTY smoke pass, confirming
  the failure cause.
- `1.2.0-beta.15` installed its helper as `0755` and completed the same `/bin/sh` PTY smoke with exit
  code zero without modification.

M6 should pin the exact verified beta initially and treat it as a release gate, not a loose range.
The packed CLI plus Node 22.19/24 macOS, Linux, and Windows native lanes must pass before release.
Do not hide an invalid dependency package with an application-time fallback to pipe or a silent
permission mutation. A later stable upgrade uses the same native contract and packaging tests.

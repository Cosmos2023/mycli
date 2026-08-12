# Optimize Node CLI startup performance

## Goal

Reduce the time from invoking `npm run mycli` to an interactive, input-ready
Node TUI while preserving runtime behavior, startup safety, and extension
availability. Keep a reproducible, opt-in startup profile so future regressions
can be diagnosed without exposing configuration or entering model context.

## What I already know

- The original production-like startup took approximately 1055 ms on this
  workspace.
- Stable runs after the first optimization batch take approximately 621-622 ms.
- The production command can use compiled JavaScript; source iteration still
  needs a separate `tsx` entry.
- Management services are irrelevant to the interactive path and can be loaded
  only for management commands.
- MCP network refresh already runs after cached extension state is available.
- Current profiling attributes roughly 260 ms to Worker/module startup and
  roughly 180 ms between storage readiness and hook discovery on a representative
  run. Skills, cached MCP, plugins, and subagent composition add only about 12 ms
  after hooks are ready.
- A focused M7 live integration smoke reaches its fixed 20-second timeout and
  retains asynchronous cleanup work; this behavior must be diagnosed separately
  from input-ready startup measurements.

## Requirements

- `npm run mycli` runs the compiled production entry without the `tsx` loader.
- `npm run dev` continues to execute current TypeScript sources with workspace
  source resolution.
- Interactive startup does not eagerly import management-only composition.
- Startup-critical helpers use narrow package exports when broad barrels pull
  unrelated runtime modules into the supervisor process.
- Backend startup and TUI module loading overlap where their dependencies allow.
- Extension state required for the first turn remains available before
  `runtime.ready`; only explicit refresh work may continue in the background.
- Opt-in startup profiling records fixed stage names and elapsed milliseconds
  only, under the user's mycli log directory with restrictive permissions.
- Profiling is disabled by default, best-effort, and never affects availability,
  session persistence, transcript content, gateway payloads, or provider input.
- Further optimization must be justified by repeated measurements and must not
  trade correctness for small cold-start gains.

## Acceptance Criteria

- [x] Stable production startup is materially faster than the approximately
      1055 ms baseline and does not regress from the measured 621-622 ms range
      without an explained environmental cause.
- [x] A real PTY smoke reaches an input-ready TUI and exits cleanly.
- [x] Profiling can be enabled with `MYCLI_STARTUP_PROFILE=1` and produces a
      bounded, credential-free JSON report.
- [x] Profiling disabled by default creates no report.
- [x] Management commands, source development, Worker supervision, and shutdown
      behavior retain regression coverage.
- [x] App, tools, integrations, runtime, TUI, typecheck, lint, contracts, and
      diff checks pass, except any independently demonstrated pre-existing flaky
      timeout is reported with a focused reproduction.
- [x] Startup behavior and the production/development command split are
      documented.

## Verification Results

- Stable real PTY input-ready samples after the final changes: 356 ms and 364 ms.
- Representative backend stages: Worker/module entry 270 ms, config 6 ms,
  current-schema storage open 6 ms, runtime object composition below 1 ms,
  integration composition 14 ms, session preparation 34 ms, gateway 6 ms.
- Current-schema SQLite initialization fell from approximately 388 ms to
  approximately 6-11 ms by avoiding repeated DDL and FTS backfill scans.
- Runtime object composition fell from approximately 159-184 ms to approximately
  1 ms by loading `o200k_base` on first actual token count.
- Storage tests: 115/115. Runtime tests: 261/261. Tools tests: 207/207. TUI tests:
  544/544. Startup-relevant integration tests: 19/19.
- Full app runs pass all ordinary startup, Worker, session, provider, and M2-M7
  flows; the independently focused `M7 live smoke emits only structural extension
  and cleanup state` test still reaches its existing fixed 20-second timeout.
- The complete integrations suite previously passed 103/103. Re-running it in
  the current Codex environment terminates the controlling stdio MCP transport;
  non-stdio startup/cache coverage was rerun separately and passed 19/19.

## Definition of Done

- Startup-critical changes have focused unit or integration coverage.
- Repeated startup profiles identify the remaining dominant costs.
- Lint, typecheck, contract checks, and relevant package tests pass.
- The backend directory-structure specification records the startup contract.
- No credentials, provider payloads, or private configuration are written to
  startup diagnostics.

## Out of Scope

- Removing or changing the Python runtime.
- Replacing Node Worker threads or redesigning the agent worker pool.
- Deferring required first-turn tools, hooks, skills, plugins, or subagent state
  merely to improve a headline startup number.
- Fixing unrelated provider/network latency.
- Broad refactors of the runtime, TUI renderer, shell approval policy, or
  subagent protocol.

## Technical Notes

- CLI entry: `backend/apps/mycli/src/cli.ts`.
- Backend Worker boundary:
  `backend/apps/mycli/src/node-runtime/node-backend-supervisor.ts` and
  `node-backend-worker.ts`.
- Backend composition: `backend/apps/mycli/src/node-runtime/node-backend.ts` and
  `integration-composition.ts`.
- Profiler: `backend/apps/mycli/src/node-runtime/startup-profile.ts`.
- Applicable project guidance:
  `.trellis/spec/backend/directory-structure.md` and
  `.trellis/spec/guides/index.md`.

## Decision (ADR-lite)

Use a compiled production entry plus a source-resolved development entry, keep
the Worker isolation boundary, overlap independent supervisor work, and measure
the backend with fixed opt-in stages. Prefer lazy imports and safe parallelism
over changing readiness semantics. Stop optimizing a stage when its measured
cost is small relative to module loading or platform scheduling.

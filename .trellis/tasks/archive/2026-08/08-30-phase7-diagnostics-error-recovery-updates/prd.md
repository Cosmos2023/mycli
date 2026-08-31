# Phase 7 Diagnostics, Error Recovery, And Updates

## Goal

Replace generic or duplicated failures with one actionable, redacted diagnostic surface, expand
provider-free health inspection, and add a non-blocking cached update notice without delaying TUI
startup.

## What I Already Know

- The approved configuration and UX roadmap defines this as Phase 7 after session continuity and
  recovery.
- mycli already has typed runtime/provider errors, bounded gateway failures, provider-free doctor
  collectors, TUI command diagnostics, and a settings row that currently reports updates as
  unavailable.
- Prior work removed several duplicate provider/auth/persistence transcript errors, but the complete
  taxonomy, recovery-action projection, support bundle, and update cache have not been unified.
- Project configuration diagnostics already own safe layer/key/line/column metadata and must remain
  the source of truth rather than being reclassified in the TUI.
- The user requested continued inline implementation without subagents.
- Seven unrelated Windows sandbox and CI files remain dirty and must not be modified, staged,
  committed, or reverted by this task.

## Requirements

- Define one stable diagnostic contract spanning config, auth, provider, sandbox, storage,
  extensions, terminal, update, and migration categories with sanitized messages, optional bounded
  detail, retryability, and explicit recovery actions.
- Ensure one root failure produces one primary TUI diagnostic rather than duplicate transcript,
  command-result, and footer errors.
- Extend provider-free doctor coverage using existing authoritative configuration, credential,
  sandbox, session, extension, and terminal sources; no implicit provider call is allowed.
- Provide stable human and JSON diagnostics without secrets, raw provider bodies, internal stacks,
  unnecessary local paths, prompts, commands, or tool content.
- Add a background update check that reads cached state for startup, refreshes without delaying first
  paint, supports opt-out and per-version dismissal, and reports package-manager guidance rather
  than self-installing when the install mechanism is not safely known.
- Keep every network/cache failure non-fatal, bounded, deduplicated, and independently testable.
- Use a 20-hour cache TTL and the npm registry metadata for `@mycli/app`; only a strict stable
  semantic version may become an advertised update.
- Expose update status and exact-version dismissal through CLI/gateway/TUI paths without executing
  a package manager, requesting privilege escalation, or mutating the installation.
- Give one request failure a stable occurrence identity so a JSON-RPC rejection and its matching
  `gateway.error` notification collapse without merging separate failures that share text.
- Enrich doctor rows with category, code, summary, bounded details, remediation, and duration while
  keeping compatibility fields until existing consumers migrate.

## Acceptance Criteria

- [x] A representative 401, provider failure, persistence failure, and config failure each render
  exactly one primary diagnostic with the correct stable category and recovery action.
- [x] Doctor remains provider-free by default and reports authoritative configuration, credential,
  sandbox, storage/session-lock, extension, terminal, and update readiness without secret values.
- [x] Human and JSON output derive from the same typed payload and pass nested redaction tests.
- [x] Update checks never delay runtime readiness or first TUI paint, obey opt-out, use a bounded
  20-24 hour cache, and do not re-prompt for a dismissed version.
- [x] Offline, malformed response, timeout, permission, cache corruption, and concurrent refresh
  cases degrade to one non-fatal status without corrupting prior valid cache state.
- [x] The current startup reads only cached update state; its network refresh is not awaited and a
  newly fetched version is first advertised on a later startup.
- [x] Dismissing version X suppresses X only; version Y remains eligible, and disabling startup
  checks performs no update network request.
- [x] One request occurrence rendered from both the response and notification lanes produces one
  row, while two distinct occurrences with identical code/message still produce two rows.
- [x] Doctor verbose and JSON modes expose the same redacted structured rows, collector duration,
  and bounded support manifest; default doctor output stays concise.
- [ ] Focused config/runtime/gateway/doctor/TUI tests plus lint, typecheck, contracts, and the full
  workspace suite pass.

## Verification Status

- Focused Phase 7 config, runtime lifecycle, gateway, doctor, update-cache, and TUI suites pass.
- `npm run lint`, `npm run typecheck`, `npm run contracts:check`, `npm run build`,
  `npm run smoke:m8`, `npm run smoke:package -- --app-only`, and `git diff --check` pass.
- The complete app workspace run reached 334 tests: 324 passed, 9 failed, and 1 was cancelled. The
  late failures are the existing Worker-pool RSS/lease timing cascade; representative failed tests
  pass in isolation. Worker-pool behavior is outside Phase 7 and was not changed here.
- Full platform-package smoke is externally blocked while downloading ripgrep 15.1.0 from GitHub
  (`UND_ERR_CONNECT_TIMEOUT`). The application-only packed smoke passes.

## Definition Of Done

- Diagnostic ownership and recovery actions are typed at the backend boundary; the TUI projects
  them without reclassifying raw exceptions.
- Doctor and update operations are provider-free unless the user explicitly requests a future
  connectivity probe.
- User-facing diagnostics and update behavior are documented and executable Trellis contracts are
  updated.
- Work is committed, archived, and journaled without unrelated Windows/CI changes.

## Out Of Scope

- Automatic package installation, privilege escalation, or self-update execution.
- Configuration migration apply/rollback, named profiles, or system configuration layers.
- OAuth/device flow, OS keychain integration, telemetry, or remote support upload.
- Phase 8 keymaps, Vim mode, themes, color modes, reduced motion, ASCII fallback, and shell
  completions.
- Modifying the unrelated Windows sandbox helper and CI work already present in the worktree.

## Technical Notes

- Plan source: `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`, Phase 7.
- Likely backend areas: runtime error contracts, `node-gateway-errors.ts`, doctor collectors and
  renderer, configuration cache/write primitives, and CLI management parsing.
- Likely TUI areas: fatal error, command diagnostics, runtime-state projection, and settings/update
  actions.
- Implementation mode is inline; no implementation, research, or check subagent may be started.

## Research References

- [`research/current-diagnostic-flow.md`](research/current-diagnostic-flow.md) - current ownership,
  duplicate paths, and the adapter boundary.
- [`research/cached-update-strategy.md`](research/cached-update-strategy.md) - Codex comparison,
  cache contract, registry source, and install guidance.
- [`research/implementation-boundaries.md`](research/implementation-boundaries.md) - approaches,
  selected batches, and failure/evolution sweep.

## Technical Approach

Extend existing authoritative errors with projection adapters. A small public diagnostic vocabulary
provides closed categories and recovery actions, while provider, config, sandbox, storage, and
gateway modules retain their local exception types and classification rules. Doctor and TUI consume
the projected payload and never parse raw exception text.

Use `~/.mycli/version.json` as a versioned, locked, atomic private cache. Startup reads the previous
record, projects that state, and starts a five-second npm registry refresh without awaiting it. The
cache preserves an exact dismissed version. Update commands report status or guidance and never run
the package manager in Phase 7.

## Decision (ADR-lite)

**Context:** mycli already has mature, specialized runtime/config error handling. Replacing it would
increase risk, while presentation-only changes would leave request identity, doctor structure, and
cache safety unresolved.

**Decision:** Add shared diagnostic projection contracts and adapters over existing error owners;
implement a provider-free structured doctor report and a Codex-style cached background update
check. Deliver the milestone in the four batches documented in
`research/implementation-boundaries.md`.

**Consequences:** Existing local exception types and compatibility doctor fields remain. New public
surfaces gain stable categories, recovery actions, request occurrence ids, and cache semantics. The
milestone does not perform automatic repair or package installation.

## Implementation Plan

1. Add diagnostic contracts, runtime/gateway mappings, request identity, and TUI deduplication.
2. Upgrade doctor rows/rendering and add terminal/update provider-free checks plus support metadata.
3. Add canonical update opt-out, atomic cache, background refresh, CLI/gateway status, dismissal,
   settings projection, and cached TUI notice.
4. Update docs/specs and run focused plus full quality gates.

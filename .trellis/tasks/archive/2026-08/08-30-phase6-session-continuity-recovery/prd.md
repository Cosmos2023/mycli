# Phase 6 Session Continuity And Recovery

## Goal

Make session discovery, resume, and recovery predictable when the workspace, model catalog,
credentials, permissions, or process ownership changed after the session was created. CLI and TUI
must use one session service and show actionable repair choices before mutating or resuming the
original session.

## What I Already Know

- The approved configuration and UX roadmap defines this as Phase 6 after the unified settings and
  command-discovery phase.
- Session preferences already persist provider, protocol, model, endpoint, auth reference,
  reasoning effort, collaboration mode, permission profile, and working directory.
- The TUI already has flat and tree session selectors, resume support, a single-owner session lease,
  and transcript projection for several interrupted and pending states.
- Phase 3 separated session-only model choices from user defaults; Phase 4 exposed effective
  permission and sandbox state; Phase 5 added a gateway-projected settings catalog. Phase 6 should
  reuse those sources rather than introduce duplicate policy or configuration logic.
- The user requested continued inline implementation without subagents.
- Seven unrelated Windows/CI files are dirty and must not be modified, staged, committed, or
  reverted by this task.

## Requirements

- Define one bounded session summary contract containing stable identity, title, canonical working
  directory, last activity, model, reasoning effort, collaboration mode, effective permission
  profile, lifecycle status, parent/fork relation, and owner-lock state.
- Back CLI and TUI session discovery with the same query service, filter vocabulary, ordering, and
  visibility rules.
- Add management commands for `session list`, `resume`, `fork`, `rename`, `archive`, `delete`, and
  `export`, including `--last`, `--all`, bounded filters, deterministic text output, and stable JSON
  output where applicable.
- Before resume, compare persisted session choices with current workspace availability, model
  catalog, credential availability, and managed permission constraints.
- Return a structured repair preview that distinguishes missing workspace, missing credential,
  unsupported model, permission override, active owner, stale owner, schema incompatibility, and
  recoverable pending interaction.
- Require explicit confirmation before any repair changes the original session. Fork-based recovery
  must preserve the original transcript and preferences.
- Keep pinned session preferences durable across restart. Current global defaults may fill only
  settings the session did not pin.
- Preserve the single-owner lease and expose active/stale/takeover state consistently in CLI, TUI,
  `/status`, and resume errors without exposing raw process details unnecessarily.
- Project pending approvals, pending questions, interrupted turns, and recoverable tool state in
  both live and resumed transcripts from persisted canonical events.
- Keep all paths, titles, filters, errors, and exported metadata bounded, sanitized, and free of
  credentials or secret-bearing provider state.

## Acceptance Criteria

- [x] CLI and TUI produce the same ordered session set for equivalent filters and visibility flags.
- [x] Session rows expose title, cwd, last activity, model/effort, mode, permission, status,
  parent/fork relation, and lock state without additional per-row storage scans.
- [x] Resume distinguishes missing workspace, credential, model, managed permission conflict,
  active lock, stale lock, schema mismatch, and pending interaction with one actionable diagnostic.
- [x] Repair preview is provider-free and does not mutate the source session; apply requires an
  explicit selected action and optimistic version/lease validation.
- [x] Session-only model, reasoning, collaboration, and permission choices survive restart without
  rewriting user defaults.
- [x] Rename/archive/delete are cancel-safe; delete is destructive and defaults to no. Export is
  redacted and never includes credentials, encrypted reasoning, or raw internal storage records.
- [x] Pending approvals/questions, interrupted turns, and recoverable tool state appear once and
  consistently during live rendering and after `/resume`.
- [x] Stale-owner takeover is visible and tested; an active owner cannot be silently displaced.
- [x] Focused storage/runtime/gateway/CLI/TUI tests plus lint, typecheck, contracts, and the full
  workspace suite pass.

## Definition Of Done

- Session metadata, query, repair, and mutation behavior has one backend owner with typed gateway
  contracts and no TUI-only policy decisions.
- Existing session storage and resume behavior remain backward compatible unless a structured repair
  is required.
- CLI/session documentation and executable Trellis contracts are updated.
- Work is committed, archived, and journaled without unrelated Windows/CI changes.

## Technical Approach

1. Extend existing storage contracts with bounded metadata, archive-aware queries, pending-state
   summaries, and read-only lease status. Persist user-facing title/archive metadata under a
   versioned `session_metadata` state key so no database version bump is required.
2. Add an app-owned session service that combines storage overviews, session preferences, model
   catalog/auth availability, workspace checks, and managed permission state into one versioned
   summary and repair-preview contract.
3. Route provider-free management CLI session operations and gateway session RPCs through that
   service. Keep `session resume` an interactive startup alias; keep JSON list/mutation/export
   commands provider-free.
4. Make TUI resume request a repair preview first. Ready sessions resume directly; recoverable
   issues open one keyboard-complete selector. Preference/cwd repairs fork before applying changes,
   leaving the original session untouched.
5. Continue deriving pending approval/question, interrupt, and recoverable tool rendering from
   canonical transcript and suspension events. Session summaries carry only bounded status flags.

## Decision (ADR-lite)

**Context**: Resume currently crosses storage metadata, session preferences, workspace/config
state, process leases, and TUI projection. Repairing these independently would create inconsistent
CLI and TUI behavior.

**Decision**: Use a backend-owned session query and repair service with typed preview/apply results.
Treat repair as an explicit pre-resume transition and keep transcript projection derived from
canonical persisted events.

**Consequences**: All clients receive consistent diagnostics and filtering, and recovery can be
tested without a provider. The service must preserve existing storage compatibility and carefully
separate read-only preview from destructive mutation.

## Expansion Sweep

- Future: the summary/query contracts can support a graphical client and remote session browser.
- Related: `/resume`, startup resume, session selectors, `/status`, CLI management, export, and
  ownership diagnostics must share the same metadata vocabulary.
- Failure cases: missing or moved workspace, stale/active lease, corrupt metadata, obsolete model,
  removed credential, tightened policy, pending approval/question, interrupted tool execution,
  concurrent rename/archive/delete, and narrow/CJK/Windows-path rendering are included.
- Deferred: cloud session sync, collaborative multi-writer sessions, storage-schema redesign,
  provider calls during repair, and automatic destructive cleanup.

## Out Of Scope

- Cloud or cross-device session synchronization.
- Multiple simultaneous writers to one session.
- Provider connectivity checks during list, preview, or resume repair.
- General storage compaction, retention automation, or transcript format redesign.
- Update checks, theme/keymap work, or Phase 7 diagnostic taxonomy expansion.
- Modifying the unrelated Windows sandbox helper and CI work already present in the worktree.

## Research References

- [`research/session-continuity-recovery.md`](research/session-continuity-recovery.md) - current
  storage/runtime boundaries, local Codex comparison, alternatives, and selected ownership model.

## Technical Notes

- Plan source: `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`, Phase 6.
- Applicable specs: `.trellis/spec/backend/runtime-tui-gateway-contract.md`,
  `.trellis/spec/backend/configuration-trust-contract.md`, and the storage/session invariants found
  in the current source and tests.
- Implementation mode is inline; no implementation, research, or check subagent may be started.

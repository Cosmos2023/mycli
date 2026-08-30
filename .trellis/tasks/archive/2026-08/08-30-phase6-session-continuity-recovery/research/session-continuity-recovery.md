# Session Continuity And Recovery Research

## Current mycli boundaries

- `SessionOverview` already comes from normalized SQLite session rows and lineage-aware event counts.
- `SessionCoordinator` owns atomic inspect/resume/new transitions and prevents switching during an
  active turn or continuation.
- `session_preferences` stores provider, protocol, model, endpoint, auth reference, reasoning effort,
  and collaboration mode. It is copied when a conversation is forked.
- `session_runtime_leases` enforces one live root owner and already permits stale-PID takeover.
- Canonical transcript events and persisted suspension state already reconstruct pending approvals,
  pending clarifications, interrupted turns, and interrupted tools after restart.
- Gateway `session.list`, `session.resume`, and `session.tree` currently expose only a narrow subset
  of this state. TUI filtering is richer than gateway filtering, so CLI and TUI can disagree.
- The provider-free management CLI has no session command family.

## Local Codex comparison

The local Codex source uses one app-server thread contract for CLI and TUI rather than letting the
picker inspect rollout files itself:

- `Thread` includes identity, session/fork/parent relations, preview/title, model provider, timestamps,
  status, cwd, source, and optional turns.
- `thread/list` owns paging, sorting, cwd/source/model filters, archive visibility, and search.
- Resume is an interactive command and can resolve a stable id or exact user-facing name.
- Rename, archive, unarchive, and delete are thin clients over app-server operations. Delete requires
  an interactive confirmation unless the caller explicitly supplies force.
- Resume restores thread-scoped settings and projects canonical interrupted history; pending server
  requests are cancelled or reconstructed at explicit lifecycle boundaries.

The useful parity target is the ownership model and typed contract, not Codex's rollout-file layout.

## Approaches

### A. TUI enrichment only

Add fields to `session.list` and teach the current selector more labels.

- Pros: smallest diff.
- Cons: management CLI still differs, mutations remain ad hoc, repair logic lands in the TUI, and
  other clients cannot reuse it.

### B. Backend session service over existing storage (selected)

Add narrow storage primitives, then build an app-owned session query/mutation/repair service used by
both management CLI and gateway.

- Pros: one query vocabulary, provider-free tests, no storage migration, and clean preview/apply
  separation.
- Cons: requires coordinated storage, app, gateway, CLI, and TUI changes.

### C. New denormalized session index/schema

Create a dedicated table containing all display and repair fields.

- Pros: fast list reads and straightforward remote-client payloads.
- Cons: duplicates canonical state, introduces drift/backfill/versioning risk, and is unnecessary at
  the current catalog size.

## Selected design

- Extend `SessionOverview` and query inputs only with data that storage can derive cheaply and
  deterministically: title metadata, archive visibility, lineage, pending state, and lease status.
- Store user-facing session metadata in versioned `session_metadata` state so the existing database
  remains readable without a schema bump.
- Keep model/reasoning/collaboration/permission projection in the app service because it owns config
  and session-preference parsing.
- Make the service return a versioned bounded summary and a typed repair preview.
- Treat repair preview as read-only. Repairs that alter durable preferences or cwd create a fork and
  update the fork; the source session is never rewritten.
- Keep archive and delete distinct. Archive is reversible status metadata; delete requires explicit
  confirmation and removes or tombstones only through one storage transaction after checking live
  ownership and descendants.
- Keep transcript rendering derived from canonical events. The session summary reports pending state
  for discovery, but does not duplicate request content.

## Safety and compatibility constraints

- Never include API keys, encrypted reasoning, provider bodies, tool arguments/output, or raw storage
  rows in list/export payloads.
- Bound title, preview, paths, filters, exported transcript text, and diagnostic messages.
- Existing sessions without metadata or new preference fields must parse with defaults.
- Active leases block rename/archive/delete/resume from other processes. Stale takeover is reported.
- Destructive actions default to cancel and JSON/non-TTY delete requires an explicit force flag.
- No provider call is allowed during list, export, or repair preview.

## Relevant files

- `backend/packages/storage/src/session-store.ts`
- `backend/packages/storage/src/transcript-event-repository.ts`
- `backend/packages/runtime/src/session-coordinator.ts`
- `backend/apps/mycli/src/node-runtime/session-preferences.ts`
- `backend/apps/mycli/src/node-runtime/node-gateway.ts`
- `backend/apps/mycli/src/management/`
- `tui/mycli-shell/src/components/session-selector.ts`
- `tui/mycli-shell/src/transcript-projection.ts`

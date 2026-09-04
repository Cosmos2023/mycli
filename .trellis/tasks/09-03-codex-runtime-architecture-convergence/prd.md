# Codex-Aligned Runtime Architecture Convergence

## Goal

Converge mycli's live Node runtime around explicit lifecycle ownership boundaries so that turn,
session, queue, continuation, storage, gateway, and TUI behavior cannot diverge through duplicated
mutable state. Preserve current observable behavior and SQLite durability while incrementally
adopting the separation of concerns demonstrated by Codex.

## Requirements

- Replace independent lifecycle booleans with discriminated, mutually exclusive state where an
  operation has one explicit owner.
- Require the exact execution or transition claim to release ownership; stale callbacks from the
  same session generation must not release newer work.
- Keep provider-neutral decisions free of storage, gateway, provider, and TUI side effects.
- Preserve session generation fencing, durable queue authority, approval/clarification recovery,
  and all current gateway payloads throughout the refactor.
- Refactor incrementally in dependency order:
  1. lifecycle and ownership state;
  2. gateway controllers and typed event projection;
  3. TUI decoding, reduction, and projection;
  4. transactional domain repositories and terminalization/outbox;
  5. immutable execution-policy and tool-catalog snapshots;
  6. narrow turn-runtime and backend composition roots.
- Add boundary-level characterization and transition-table tests before each behavior-preserving
  migration.
- Do not introduce a second runtime, replace SQLite, remove Write/Edit/Patch, or make real model
  calls part of correctness tests.
- Perform the work inline in the primary session; do not dispatch subagents.

## Initial Delivery Slice

The first slice replaces `SessionCoordinator`'s independent `executing` and `transitioning`
booleans with a dedicated session-operation state machine. It introduces identity-bearing claims
for execution and session transitions, migrates Gateway ownership release to those claims, and
keeps public RPC and event behavior unchanged.

## Acceptance Criteria

### Slice 1: Session Operation Ownership

- [x] Idle, executing, and transitioning are represented by one discriminated state.
- [x] Execution and transition claims are mutually exclusive.
- [x] Only the exact active claim can release or complete an operation.
- [x] Stale session generation contexts cannot claim or mutate the active session.
- [x] Failed preparation and reservation paths release only their own claim.
- [x] Successful resume/new-session commit advances the generation and returns to idle atomically.
- [x] Existing submit, queued-turn, approval, clarification, interrupt, and session-switch behavior
      remains covered by tests.

### Later Slices

- [x] Gateway transport is separated from session, turn, interactive, shell, and settings control.
- [x] Runtime events are ownership-stamped and mapped through one typed projection boundary.
- [x] TUI event decoding, state reduction, transcript projection, and feature presentation are
      separate modules, with native chat using the same action dispatcher.
- [x] Terminal storage transitions use focused repositories and one transaction/outbox boundary.
- [x] Every run owns immutable effective-policy and tool-catalog snapshots.
- [ ] `NodeTurnRuntime` and `node-backend.ts` become composition/orchestration boundaries rather
      than alternate owners of lifecycle truth.

## Definition of Done

- Each slice has pure transition tests plus integration coverage at every migrated boundary.
- `npm run lint`, `npm run typecheck`, `npm run contracts:check`, `npm test`, and
  `git diff --check` pass before the corresponding slice is committed.
- Architectural contracts are updated when ownership or cross-layer behavior changes.
- No compatibility behavior is removed without an explicit migration and regression coverage.

## Technical Approach

Use explicit, small state machines rather than a generic framework. For Slice 1, a pure runtime
module owns `idle | executing | transitioning`, session-generation identity, and claim identity.
`SessionCoordinator` remains responsible for preparing bindings and leases, but delegates legal
operation transitions to that module. Gateway `ActiveTurn` retains the returned execution claim
and uses it for release, preventing a stale completion from clearing a newer execution.

Subsequent slices consume this ownership boundary before moving responsibilities out of the
Gateway, TUI reducer, SQLite store, and turn runtime.

## Decision (ADR-lite)

**Context**: Current package boundaries are useful, but live execution recombines state in large
application objects. In particular, session execution and transition ownership are represented by
independent booleans and released by context rather than by the operation that acquired them.

**Decision**: Establish explicit identity-bearing lifecycle claims first, then extract controllers
and projections in dependency order. Align Codex's ownership boundaries and observable behavior
without copying its in-memory persistence model over mycli's durable SQLite queue.

**Consequences**: The work is delivered in small behavior-preserving slices. Some compatibility
fields and large composition files remain temporarily, but every later extraction has a stable
ownership primitive and transition test suite to build on.

## Out of Scope

- A one-shot rewrite of Gateway, runtime, storage, or TUI.
- Provider transport, model catalog, compaction-policy, or release changes.
- Replacing SQLite with Codex's persistence implementation.
- Visual redesign unrelated to lifecycle projection.
- Real provider requests as test dependencies.

## Research References

- [`../09-02-codex-steer-interrupt-lifecycle/research/codex-module-boundary-audit.md`](../09-02-codex-steer-interrupt-lifecycle/research/codex-module-boundary-audit.md)
  - structural comparison and six-stage refactor order.
- [`../09-02-codex-steer-interrupt-lifecycle/research/codex-input-lifecycle-parity.md`](../09-02-codex-steer-interrupt-lifecycle/research/codex-input-lifecycle-parity.md)
  - observable Codex/mycli input-lifecycle mapping.
- [`../09-02-codex-steer-interrupt-lifecycle/research/confirmed-bug-ledger.md`](../09-02-codex-steer-interrupt-lifecycle/research/confirmed-bug-ledger.md)
  - regression inventory used as architectural acceptance evidence.

## Technical Notes

- `backend/packages/runtime/src/session-coordinator.ts` currently owns `#executing` and
  `#transitioning` independently.
- `backend/apps/mycli/src/node-runtime/node-gateway.ts` acquires by generation context and releases
  with a separate boolean call at submit, queue, approval, clarification, and terminal paths.
- `backend/packages/core/src/turn-state.ts`, `approval-continuation.ts`, `queue-state.ts`, and
  `agent.ts` already demonstrate explicit pure transition functions; the new module should follow
  those conventions rather than introduce a state-machine dependency.

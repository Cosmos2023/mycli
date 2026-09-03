# Codex-Aligned Steer, Interrupt, and Queue Lifecycle

## Goal

Align mycli's observable input lifecycle with Codex across
`steer -> interrupt -> terminal event -> queue/resume`. User input must not be lost, duplicated,
attached to the wrong turn, or carried into another session. Mycli's SQLite-backed queue remains
the durable source of truth.

## Requirements

- Preserve queue identity end to end: queue ID, client message/turn ID, session ID, target turn ID,
  kind, delivery state, source, revision, text, and image descriptors.
- Treat the TUI queue as an optimistic projection only. Reconcile optimistic and durable records
  by identity instead of concatenating two dispatch queues.
- Interpret steer ACK as proof of persistence, not proof of consumption. Retire a pending steer
  only after matching committed user-item lifecycle, explicit removal, or terminal restoration.
- Route all follow-ups through the durable backend `turn.follow_up` path.
- Classify queue RPC failures. Persistence, capacity, and protocol failures restore exact input to
  the composer and render one actionable error rather than pretending the steer was rejected.
- Make Esc work during the Enter-to-`turn.started` window and keep immediate-resubmit intent
  monotonic across repeated Esc presses.
- Match Codex interrupt behavior: pending steers are submitted once after interruption when Esc
  was used to steer; ordinary interruption restores pending/rejected/follow-up input to the
  composer in deterministic order.
- Preserve and stably renumber image placeholders when multiple queued messages are restored.
- Fence every terminal mutation by session generation and turn ID.
- Use one backend finalization path for completed, failed, interrupted, approval, and clarification
  continuations, followed by idempotent next-input scheduling.
- Schedule queued work after terminal completion, failure, interruption, idle enqueue, and idle
  session resume.
- Replace remove-before-start queue dispatch with a recoverable durable claim tied to the reserved
  turn; retire the record only after matching user input persistence.
- Snapshot composer draft, pending images, and pre-ACK optimistic input per session.
- Keep legacy queue fields readable during a compatibility window, but stop destructive bootstrap
  migration ACK from transferring durable ownership into TUI memory.
- Document queue ownership, ACK meaning, terminal ordering, recovery, and session fencing.

## Acceptance Criteria

- [x] Event-before-ACK and ACK-before-event each render one steer preview.
- [x] A late ACK cannot remove or downgrade a steer already deferred by a terminal race.
- [x] Esc before `turn.started` sends exactly one interrupt request.
- [x] Esc with pending steers starts exactly one next turn containing every steer in order.
- [x] Repeated Esc cannot clear immediate-resubmit intent or dispatch twice.
- [x] A stale terminal event cannot change a newer turn's status, transcript, tools, approval, or
      clarification state.
- [x] Completed, failed, and interrupted turns all schedule the next dispatchable record after
      durable terminal finalization.
- [x] A steer arriving on either side of active-turn cleanup is eventually committed exactly once.
- [x] Restarting or resuming an idle queued session preserves and schedules its input.
- [x] Follow-ups survive process exit, gateway restart, `/resume`, and session switching.
- [x] Dequeue edits the newest durable user follow-up, including after restart.
- [x] Session switching restores only the target session's draft and attachments.
- [x] Restoring two image messages preserves both paths and unique, correct placeholders.
- [x] Queue persistence/capacity failures restore exact input and render one error.
- [x] Failure between queued-turn reservation and execution leaves a recoverable record and never
      creates duplicate committed user input.
- [x] Queue previews and Esc hints disappear when the authoritative queue is empty.

## Definition of Done

- Unit tests cover core state transitions and TUI reconciliation.
- Gateway integration tests use controlled barriers for all relevant event/RPC orderings.
- A temporary-SQLite restart test covers durable queued-turn recovery.
- A scripted TUI test covers submit -> steer -> Esc -> interrupt terminal -> automatic next turn.
- `npm run typecheck`, `npm run lint`, `npm run contracts:check`, `npm test`, and
  `git diff --check` pass for the completed change.
- `.trellis/spec/backend/runtime-tui-gateway-contract.md` records the final lifecycle contract.
- Changes are delivered in focused commits without including unrelated provider/configuration WIP.

## Technical Approach

1. Add characterization tests for the known races before modifying behavior.
2. Introduce an identity-preserving queued-input projection shared by gateway parsing and TUI
   state. Use a keyed optimistic overlay and monotonic queue revisions.
3. Route follow-ups, dequeue, and clear through durable backend queue RPCs.
4. Align Esc and composer restoration with Codex, including attachment placeholder rebasing.
5. Centralize backend terminal finalization and schedule from every idle transition.
6. Add a durable in-flight queue claim and restart reconciliation.
7. Add per-session composer snapshots, remove legacy TUI queue ownership, update contracts, and run
   full verification.

## Decision (ADR-lite)

**Context**: mycli currently combines local TUI pending/rejected/follow-up arrays with a durable
backend queue. RPC responses and runtime events can arrive in either order, so two mutable sources
produce duplicate previews, lost input, and stale terminal mutations.

**Decision**: preserve mycli's backend queue as the sole durable authority and reproduce Codex's
observable lifecycle through an identity-keyed TUI optimistic overlay. Centralize terminal
finalization and make queue dispatch recoverable and idempotent.

**Consequences**: the change crosses core, runtime, storage, gateway, contracts, and TUI layers and
requires race-focused tests. It avoids a full queue rewrite and improves restart behavior beyond a
purely local Codex-style input queue.

## Out of Scope

- Provider transport, model selection, compaction, and tool execution changes.
- General transcript or TUI visual redesign unrelated to queued input.
- Replacing SQLite queue persistence.
- Maintaining two independently dispatchable queues for backward compatibility.
- Real model API calls as a correctness dependency.

## Research References

- [`research/codex-input-lifecycle-parity.md`](research/codex-input-lifecycle-parity.md) - direct
  source comparison between Codex and mycli and the resulting behavioral mapping.
- [`research/confirmed-bug-ledger.md`](research/confirmed-bug-ledger.md) - stable numbered ledger of
  36 confirmed lifecycle defects plus evidence for the latest audit findings and uncounted risks.

## Technical Notes

- Core durable identity already exists in `backend/packages/core/src/queue-state.ts:16`.
- Gateway publishes full `queue_items` in
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:4269`.
- TUI currently drops identity at `tui/mycli-shell/src/adapters/runtime-state.ts:129` and
  concatenates local/durable previews at `tui/mycli-shell/src/adapters/runtime-state.ts:525`.
- The current ACK removes local input at `tui/mycli-shell/src/adapters/runtime-state.ts:2156`.
- Backend scheduling currently converges at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2659`.
- Queue removal before active-turn construction occurs at
  `backend/apps/mycli/src/node-runtime/node-gateway.ts:2678`.
- The working tree contains unrelated provider/configuration/release changes; implementation must
  preserve them.

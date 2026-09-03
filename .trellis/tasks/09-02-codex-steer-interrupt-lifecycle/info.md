# Technical Design: Steer, Interrupt, and Queue Lifecycle

## Invariants

1. One user intent has one stable client identity across retries and event races.
2. The backend durable queue is the only component allowed to schedule queued work.
3. TUI optimistic state may improve latency but may not outlive or override durable state.
4. Queue transitions are monotonic and idempotent.
5. Terminal events mutate state only when their session generation and turn ID match the owner.
6. A queued record is not deleted until its replacement ownership is durable.
7. Session switching never transfers composer or attachment state between sessions.

## Proposed State Model

Visible queued input moves through:

```text
optimistic
  -> persisted/accepted (steer targets active turn)
  -> persisted/deferred (follow-up or rejected steer)
  -> claimed (reserved for a concrete next turn)
  -> committed (matching user item persisted)
  -> retired
```

Recovery transitions:

```text
accepted + owning turn interrupted/failed -> deferred
optimistic + RPC failure                -> composer
claimed + matching active turn          -> claimed
claimed + matching committed user item  -> retired
claimed + no active/committed owner      -> deferred
```

## Ownership Boundaries

- `backend/packages/core`: pure queue states, validation, identity, transitions.
- `backend/packages/runtime`: persistence-before-publication and recovery coordination.
- `backend/packages/storage`: durable snapshot/claim representation and committed-item lookup.
- `backend/apps/mycli`: terminal orchestration, scheduling, session generation fencing, RPC shape.
- `backend/packages/contracts`: canonical queue/event payload shape where applicable.
- `tui/mycli-shell`: optimistic overlay, identity reconciliation, composer/session UX.

## Terminal Finalization Order

1. Validate owning session generation and turn ID.
2. Persist terminal state.
3. Commit consumed steers or defer unconsumed steers.
4. Release active-turn ownership.
5. Publish terminal and idle projections.
6. Invoke the idempotent scheduler.

All terminal paths call this sequence. Enqueue and resume paths call the same scheduler after they
reach an idle state.

## Compatibility

- Read old queue snapshots containing `queued`, `accepted`, and `committed` states.
- Introduce claimed/in-flight state through a deterministic storage migration or compatible JSON
  decoder default.
- Continue publishing legacy projection fields for one compatibility window if tests show an
  active consumer, but the TUI must consume `queue_items` exclusively.
- Do not acknowledge legacy migration merely because records were rendered by the TUI.

## Planned Delivery Slices

1. Characterization tests plus identity-preserving TUI types.
2. Durable follow-up RPC and monotonic reconciliation.
3. Esc/interrupt restoration and image rebasing.
4. Unified terminal finalization and idle scheduling.
5. Durable claim and restart recovery.
6. Per-session composer snapshots, compatibility cleanup, specs, and full gates.


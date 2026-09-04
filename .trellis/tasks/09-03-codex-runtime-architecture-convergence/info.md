# Technical Design: Runtime Architecture Convergence

## Dependency Order

```text
session/turn ownership
  -> gateway controllers + typed projection
  -> TUI decoder/reducer/projector
  -> transactional terminal repositories
  -> policy/tool snapshots
  -> narrow runtime/backend composition
```

The ordering is intentional. Extracting large files before establishing ownership would move the
same ambiguous mutable state into more files without fixing the lifecycle contract.

## Slice 1 State Model

```text
idle(context)
  -> executing(context, executionClaim)
  -> idle(context)

idle(context)
  -> transitioning(context, transitionClaim)
  -> idle(nextContext)       on commit
  -> idle(originalContext)   on abort
```

An operation state is a discriminated union, so executing and transitioning cannot both be true.
Claims are frozen identity objects created only by the state transition. Releasing with another
claim, including a structurally identical object, is rejected.

## Ownership Boundaries

- Pure session-operation transitions live in `backend/packages/runtime` and have no IO.
- `SessionCoordinator` owns the current operation state, session snapshot, binding preparation,
  and lease callbacks.
- Gateway owns the lifetime of an `ActiveTurn`, but must retain the execution claim returned by
  `SessionCoordinator` and return that exact claim during cleanup.
- Storage remains the durable authority for turns and queues; Slice 1 changes no schema or payload.

## Failure Rules

- A stale context cannot acquire execution or transition ownership.
- A failed credential check, reservation, queue claim, session preparation, or lease acquisition
  releases only the claim acquired for that attempt.
- A late completion cannot release a newer execution in the same generation.
- Transition commit updates the active snapshot and operation context before asynchronous source
  lease cleanup can observe the new state.
- Repeated cleanup is idempotent and cannot mutate another owner's state.

## Compatibility

- Keep `SessionCoordinator.executing()` as a read projection for current consumers.
- Replace `markExecuting(context, boolean)` with explicit claim/release methods; do not retain a
  second compatibility mutation path.
- Keep gateway RPC methods, event names, and status projection unchanged in Slice 1.

## Slice 3 TUI Projection Boundaries

```text
validated GatewayEvent
  -> typed decoder + direct/mirror deduper
  -> session/generation/turn ownership fence
  -> feature reducer
  -> lifecycle reducer
  -> incremental transcript projector
  -> full TUI or native-chat presenter
```

- `runtime.event` envelopes retain root ownership separately from a child payload subject.
- Gateway scheduling flags react only to an applied decoded event; rejected stale events have no
  lifecycle or dispatch side effects.
- A terminal event must match at least one known active turn identity, and an explicit mismatch is
  always rejected.
- Child interactive ownership is released only by its matching response or
  `interactive.cancelled`, never by a terminal `subagent.updated` presentation event.
- Full and native chat clients share `MycliUiActionDispatcher`; their rendering and input adapters
  do not own separate Gateway semantics.

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

## Slice 4 Transaction And Outbox Boundaries

```text
turn terminalization command
  -> one SQLite write transaction
     -> canonical transcript/display rows
     -> durable turn_lifecycle outbox row
     -> runtime_turns terminal state
     -> session activity timestamp
  -> committed { turn, outbox } result
  -> runtime event projection

agent lifecycle command
  -> one SQLite write transaction
     -> subagent_tasks transition
     -> agent_threads + agent_spawn_edges transition
  -> committed { task, thread } result
  -> supervisor state and lifecycle projection
```

- The canonical `turn_lifecycle` transcript event is the durable terminal outbox. Slice 4 does not
  add a second delivery table or change schema v12.
- A completed, failed, or interrupted root turn returns its committed turn and exact persisted
  lifecycle event from the repository transaction. `NodeTurnRuntime` maps that result instead of
  reconstructing a terminal event from pre-commit inputs.
- Readable transcript rows, model-visible terminal rows, the lifecycle outbox, `runtime_turns`, and
  the session activity timestamp either commit together or roll back together. Regenerable JSON
  artifacts remain post-commit projections and cannot change canonical terminal truth.
- Agent activation, follow-up activation, completion, failure, and interruption transition their
  task and thread records through one composite repository using the store's nested transaction
  helper. The supervisor consumes only the committed pair.
- Queued cancellation uses the same composite repository and compares the task update against its
  actual current status, so a pre-start interrupt cannot leave a queued task behind an interrupted
  thread.
- Process-restart and targeted runtime-owner recovery retain their distinct fixed persisted reasons;
  general runtime failures continue through canonical message sanitization.
- Repository failpoints run between related writes so tests can prove no half-transition survives a
  thrown error. Failpoints are test-only constructor inputs and do not alter the database schema or
  public gateway payloads.
- Compatibility `completeTurn()` and `failTurn()` methods remain for non-runtime callers, but the
  live runtime uses the terminalization result and its durable outbox directly.

## Slice 5 Run Execution Snapshot Boundary

```text
current mode + effective policy + current integration catalog
  -> create one immutable run snapshot before provider IO
     -> direct tools + deferred tools + skill catalog
     -> policy profile + trust/configuration provenance
  -> provider steps select durable activations from that catalog only
  -> approval/clarification persist and restore the same snapshot
  -> compaction counts the same frozen catalog plus latest run activations
  -> subagents inherit tools and policy from the exact parent run
```

- `NodeTurnRuntime` is the sole owner of the process-local run snapshot. Mode, policy, catalog, and
  skill discovery are resolved once when the execution context is first prepared; terminal cleanup
  releases the snapshot together with router, approval, and policy turn state.
- The tool catalog is a deep-frozen validated copy with a deterministic fingerprint. It bounds
  individual schemas, total definitions, catalog bytes, and continuation bytes before state is kept
  or restored.
- `tool_search` remains the only widening mechanism inside a run. It may activate only definitions
  in the frozen deferred catalog, and both discovery and routing reject current adapters whose full
  definition no longer matches the frozen definition.
- Approval and clarification continuations store `run_snapshot` under the existing suspended-turn
  continuation object. A restart restores it by turn identity; an in-process continuation must match
  the already active snapshot exactly before executing any resolution effect.
- Execution-policy restoration uses the frozen effective profile as the active turn base. An
  explicit user-approved permission grant replaces only the policy portion with another immutable
  snapshot while retaining the original mode and tool catalog.
- Compaction base context is lazily resolved for each estimate so newly persisted activations are
  counted from the frozen catalog. Background extension refreshes cannot enter the active run.
- Subagent spawn resolves the parent's exposed tools and effective policy by parent session and turn.
  Missing snapshot state fails closed, and child-requested tool lists remain narrowing-only.
- The Worker-backed root wrapper forwards snapshot lookup; it does not duplicate or reconstruct
  lifecycle truth.

## Slice 6 Runtime And Backend Composition Boundary

```text
NodeTurnRuntime
  -> RunExecutionCoordinator        mode, policy, immutable run snapshot
  -> AgentBudgetTracker             provider/tool/token/time budget state
  -> ToolBatchCoordinator           approval/hook barriers and ordered tool phases
       -> ActiveToolExecutionRegistry  exact claims, abort, terminal events

startNodeBackend
  -> NodeRuntimeRegistry            session-to-runtime identity
  -> NodeBackendResourceOwner       one ordered idempotent shutdown
  -> SerializedSessionArtifactQueue accepted-prefix projection drain
  -> node-session-bootstrap         recovery and derived artifact projection
  -> node-runtime-trace             bounded best-effort diagnostics
```

- `NodeTurnRuntime` retains provider-loop, continuation, compaction, and committed terminalization
  sequencing. It no longer stores collaboration-mode maps, run-snapshot maps, budget counters, or
  active-tool maps, and it delegates complete durable tool batches to `ToolBatchCoordinator`.
- `ToolBatchCoordinator` preserves the existing manifest-gated phase rules: safe calls may overlap,
  barriers flush first, approval/clarification suspend only after earlier results are durable, and
  all results, hooks, context, and replay remain in provider order.
- Active calls use identity-bearing claims keyed by the full raw call id. Bounded ids are presentation
  fields only, so stale completions and colliding display prefixes cannot release newer work.
- The backend registry conditionally removes only the runtime instance that acquired a binding.
  Resource shutdown returns one promise, attempts every operation in dependency order, drains
  accepted projections, and closes SQLite last.
- Session bootstrap and trace serialization moved out of the app composition file. SQLite remains
  canonical; snapshots, artifacts, and traces remain derived or diagnostic outputs.
- This slice changes no Gateway RPC, TUI event, SQLite schema, provider wire format, or local tool
  behavior. `NodeTurnRuntime` decreased from roughly 2,700 to 2,020 lines and `node-backend.ts` from
  roughly 4,050 to 2,737 lines while retaining the same characterization suite.

# Runtime Composition Contract

> Ownership rules for the Node turn orchestrator and backend composition root.

## Scenario: Narrow Runtime And Backend Composition Boundaries

### 1. Scope / Trigger

- Trigger: changing `NodeTurnRuntime`, provider/tool loop sequencing, active tool interruption,
  per-run policy/catalog state, backend runtime lookup, session recovery projection, trace writing,
  serialized artifacts, or backend shutdown.
- This boundary keeps orchestration in the runtime and dependency selection in the app without
  letting either large composition class become a second lifecycle or persistence authority.

### 2. Signatures

- Run authority: `RunExecutionCoordinator.resolve(turnId, restoredSnapshot?)`,
  `refreshPolicy(turnId)`, `snapshot(turnId)`, and `finish(turnId)`.
- Budget authority: `AgentBudgetTracker.beginProviderStep()`, `reserveToolCalls(count)`,
  `observeProviderOutput(input)`, and `wallClockExhaustion()`.
- Active-call authority: `ActiveToolExecutionRegistry.begin(input, emit)`, `complete(claim, ...)`,
  `fail(claim, ...)`, `interrupt(claim, ...)`, and `interruptTurn(turnId, emit)`.
- Tool orchestration: `ToolBatchCoordinator.process(input)`.
- Runtime lookup: `NodeRuntimeRegistry.get(sessionId)`, `set(sessionId, runtime)`,
  `delete(sessionId, expected)`, and `refreshExtensions()`.
- Resource lifecycle: `NodeBackendResourceOwner.bindIntegration(close)` and `close()`.
- Derived artifacts: `SerializedSessionArtifactQueue.run(operation)`, `drain()`, and `close()`.

### 3. Contracts

- `NodeTurnRuntime` owns provider-loop order: prepare one execution context, optionally compact,
  dispatch one provider step, durably append the complete assistant tool-call batch, delegate that
  batch, refresh activated exposure, and terminalize from committed storage output.
- `RunExecutionCoordinator` is the only process-local owner of collaboration-mode overrides,
  effective policy, and immutable run snapshots. Terminal cleanup removes mode and snapshot state
  together and delegates policy cleanup once.
- `AgentBudgetTracker` is the only owner of provider-step, tool-call, token, no-progress, and
  wall-clock counters. The first exhaustion kind is stable for the lifetime of the runtime.
- `ToolBatchCoordinator` owns phase-local tool scheduling. Approval, denial, hook modification,
  sequential barriers, and clarification flush pending parallel work first. Parallel effects may
  overlap, but completions, persistence, post-tool hooks, generated context, and replay remain in
  original provider order.
- `ActiveToolExecutionRegistry` owns full call-id identity, per-call abort signals, exactly-once
  terminal events, and bounded diagnostics. Completion, failure, and interruption require the exact
  claim returned by `begin`; a stale claim cannot close replacement work.
- `NodeRuntimeRegistry` is the sole session-to-runtime registry. Conditional delete requires the
  expected runtime instance so late child cleanup cannot remove a replacement binding. Extension
  refresh iterates a stable snapshot of registered runtimes.
- `NodeBackendResourceOwner.close()` is idempotent and returns one shared promise. It attempts every
  cleanup operation in order: update producer, integration producer, agent workers, shell manager,
  shell lifecycle drain, artifact drain, then SQLite close. It rethrows the first failure only after
  later cleanup has been attempted.
- `SerializedSessionArtifactQueue.close()` rejects new work and drains exactly the accepted prefix.
  Derived JSON artifacts may fail independently and never become canonical transcript authority.
- `node-session-bootstrap.ts` reconstructs writable session bindings and derived artifacts from
  canonical SQLite state. `node-runtime-trace.ts` owns allowlisted, bounded, best-effort diagnostic
  serialization. Neither module reconstructs provider truth from its derived files.
- Gateway RPCs, runtime/TUI events, SQLite schema, provider wire requests, and Write/Edit/Patch
  semantics do not change merely because a responsibility moves behind one of these owners.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Structurally equal but non-identical tool claim completes | Reject without changing active state |
| Two raw call ids share the same bounded display prefix | Track and interrupt both independently |
| Tool capability lookup is absent or throws | Treat the call as a sequential barrier |
| Parallel sibling throws or the turn is interrupted | Abort the phase, terminalize each started call once, persist no late result |
| Approval or clarification occurs after a parallel phase | Persist the earlier phase in provider order before suspension |
| Runtime cleanup races a replacement binding | Conditional delete leaves the replacement registered |
| `close()` is called repeatedly | Return the same promise and execute each cleanup operation once |
| An early close operation fails | Continue later cleanup, then reject with the first failure |
| Artifact work is submitted after close starts | Reject it without extending the accepted drain prefix |
| Trace or derived artifact persistence fails | Contain the projection failure; do not rewrite canonical turn state |

### 5. Good/Base/Bad Cases

- Good: `Read`, `Read`, `Write`, `Read` delegates to one parallel read phase, one sequential write
  barrier, and one final read phase while persisting results in the original order.
- Good: a stale child runtime closes after its session id has been rebound; conditional delete
  returns `false` and preserves the current runtime.
- Good: backend shutdown stops producers before draining shell/artifact projections and closing the
  store, even when an earlier producer reports an error.
- Base: a runtime without policy or extension services still receives one default immutable run
  snapshot and executes unclassified tools sequentially.
- Bad: keep shadow `Map`s for snapshots, active tools, or session runtimes in the composition class.
- Bad: use completion order as persistence order, or close SQLite before queued artifact reads have
  drained.

### 6. Tests Required

- Unit tests cover exact tool claims, full-id collisions, stable first budget exhaustion, frozen
  run snapshots, conditional runtime deletion, stable refresh iteration, close order/idempotency,
  first-error cleanup, and accepted-prefix artifact draining.
- Runtime characterization tests cover sequential and parallel phases, barriers, per-call sandbox
  authorization, ordinary failed results, hook rewrites, approval/clarification suspension,
  interruption, no late persistence, and provider-order replay.
- Backend integration tests cover startup failure cleanup, Worker root/child execution, session
  recovery, exclusive leases, extension refresh, durable approvals, and close-drain behavior.
- Run build, lint, type-check, contracts/config drift, focused runtime/app tests, the complete
  repository suite, and `git diff --check` before committing this boundary.

### 7. Wrong vs Correct

#### Wrong

```typescript
const runtimeBySessionId = new Map<string, Runtime>();
const activeCalls = new Map<string, AbortController>();
await Promise.all(calls.map((call) => executeAndPersist(call)));
store.close();
```

#### Correct

```typescript
runtimeRegistry.set(sessionId, runtime);
const result = await toolBatchCoordinator.process({
	context,
	batch,
	accumulatedUsage,
	exposedTools,
});
await resourceOwner.close();
```

Each mutable lifecycle has one identity-aware owner; composition code only wires those owners and
preserves the established execution order.

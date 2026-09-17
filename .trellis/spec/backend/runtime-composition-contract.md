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
- Parallel approvals: `ParallelApprovalCoordinator.begin(input)`, `respond({ decisionId, choice })`,
  `waitForApproval(callId)`, `restore(signal, emit)`, `abortPending()`, `finish()`, and `recover()`.
- Live responses: `NodeTurnRuntime.hasActiveApproval(decisionId)` and
  `respondActiveApproval(input)`; Worker wrappers forward these without acquiring another lease.
- Storage: `saveParallelApprovalBatch({ sessionId, workspaceRoot, threadId, suspendedTurn,
  expectedRevision? })` and `clearParallelApprovalBatch(sessionId, turnId, batchId)`.
- Runtime lookup: `NodeRuntimeRegistry.get(sessionId)`, `set(sessionId, runtime)`,
  `delete(sessionId, expected)`, `getOrCreate(sessionId, create)`,
  `dispose(sessionId, expected)`, `stop()`, `close()`, and `refreshExtensions()`.
- Resource lifecycle: `NodeBackendResourceOwner.bindIntegration(close)` and `close()`.
- Embedded client lifecycle: app-owned `BackendService.attach()`, `snapshot()`, and `close()`.
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
- `ToolBatchCoordinator` owns phase-local scheduling. Parallel-capable calls can independently
  await approval and execute within one phase. Denial by policy, sequential calls, clarification,
  permission grants, and prepared mutation guards retain barriers. Legacy single-approval
  continuations remain readable and preserve sequential suspension.
- Headless exec/review explicitly select `approvalMode: "suspend"` to return exit 3 for unanswered
  requests. The next cold activation interrupts that historical wait. The supervisor forwards this
  option; it grants no execution authority.
- Live completion events follow actual completion; result persistence, post-tool hooks, generated
  context, and provider replay remain in original provider order. A later approved call can finish
  while an earlier call is waiting for approval or output. The next provider step waits for the phase.
- The active turn and its root Worker lease remain owned during live approvals. The gateway
  validates session/generation/decision identity, persists the response through the active runtime,
  and advances its single visible prompt before the approved invocation returns.
- A bounded `suspended_turn.parallel_batch` stores `batch_id`, revision, original and prepared
  execution calls, exact-call sandbox authority, approval requests, and choices. Revision zero has
  no choices; each subsequent CAS writes exactly one previously unanswered choice. Calls and the
  frozen run snapshot cannot change. SQLite updates the batch, projected `pending_decision`, and
  `turn_record` atomically. Transcript storage validates the original ordered calls against their
  canonical batch and stores its event reference instead of a second conversation.
- The existing effect ledger is the execution authority: stable session/turn/call attempt IDs claim
  each execution once. Completed results are reused on restart; reserved or unknown effects
  terminalize the turn without automatic replay. Transcript terminalization consumes the ledger
  atomically, preserving completed sibling results and marking started mutations as unknown.
- Pending waiters abort together on cancellation or phase failure. Late decisions fail, started
  calls receive cancellation, and conditional cleanup cannot delete another batch. Cold session
  activation interrupts stored waits and clears batch state; a live client reattachment preserves
  the runtime's existing waiters.
- Approved Shell invocations retain normal `yield_time_ms`. No approval-specific zero-yield hint
  exists. The invocation may return a running handle at its deadline; `ShellSessionManager` owns
  the process afterward, and dependencies wait explicitly through `WriteStdin`.
- `ActiveToolExecutionRegistry` owns full call-id identity, per-call abort signals, exactly-once
  terminal events, and bounded diagnostics. Completion, failure, and interruption require the exact
  claim returned by `begin`; a stale claim cannot close replacement work.
- `NodeRuntimeRegistry` is the sole session-to-runtime registry. Conditional delete requires the
  expected runtime instance so late child cleanup cannot remove a replacement binding. Extension
  refresh iterates a stable snapshot of registered runtimes. Async creation coalesces per session
  without blocking other sessions. Each binding owns its integration composition/subscription;
  conditional disposal closes that instance only. Shutdown cancels preparation and disposes late
  successful results without publication. No second session/runtime map is permitted. Register
  a newly prepared runtime before `AgentMailbox.repair`: delivery resolves its queue through this
  registry. Repair before publication silently omits the restored follow-up from model input.
- `BackendService` owns the supervisor lifetime independently of local client attachments.
  Its controller/observer registry contains connection state only, never session bindings or
  another turn scheduler. A detached controller's accepted mutating RPCs fence handoff until
  settlement; its ongoing turn, approvals, and processes remain owned by the runtime. Bootstrap
  re-emits only the live interaction queue's current prompt. Service close delegates backend
  cleanup once and closes every client; stdio remains a host that closes on external EOF/signals.
- `NodeBackendResourceOwner.close()` is idempotent and returns one shared promise. It attempts every
  cleanup operation in order: update producer, integration producer, agent workers, shell manager,
  shell lifecycle drain, artifact drain, then SQLite close. It rethrows the first failure only after
  later cleanup has been attempted.
- `SerializedSessionArtifactQueue.close()` rejects new work and drains exactly the accepted prefix.
  Derived JSON artifacts may fail independently and never become canonical transcript authority.
- `node-session-bootstrap.ts` reconstructs writable session bindings and derived artifacts from
  canonical SQLite state. `node-runtime-trace.ts` owns allowlisted, bounded, best-effort diagnostic
  serialization. Neither module reconstructs provider truth from its derived files.
- `SessionCoordinator.prepare(sessionId, intent)` distinguishes `resume` from `inspect`. Before
  constructing a cold resumed runtime, `interruptSessionForResume(sessionId)` requires this store's
  session lease and atomically closes unfinished turns, synthetic tool results, one interrupted
  notice, and pending approval/question/effect state. Completed sibling results survive; claimed
  effects retain unknown-outcome diagnostics. Inspection, live runtime reuse and `session.bootstrap`
  never call it. Transcript inspection and degraded read-only snapshots use a non-executing binding
  and start no MCP clients or plugins. Retained virtual sessions reuse their original workspace.
- Gateway RPCs, runtime/TUI events, SQLite schema, provider wire requests, and Write/Edit/Patch
  semantics do not change merely because a responsibility moves behind one of these owners.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Structurally equal but non-identical tool claim completes | Reject without changing active state |
| Two raw call ids share the same bounded display prefix | Track and interrupt both independently |
| Tool capability lookup is absent or throws | Treat the call as a sequential barrier |
| Parallel sibling throws or the turn is interrupted | Abort the phase, terminalize each started call once, persist no late result |
| Parallel approval occurs in a compatible phase | Persist all requests, await each separately, and keep the turn active |
| Sequential approval or clarification occurs after a parallel phase | Persist the earlier phase in provider order before suspension |
| First approved Shell is inside its foreground wait | Publish and accept the next approval without waiting for the first invocation |
| Duplicate, stale, canceled, or unsupported decision | Reject without changing another waiter or claiming an effect |
| Revision or frozen-call mismatch | Fail the write and preserve the previous approval projection |
| Failure after batch state writes | Roll back batch, pending decision, and turn state together |
| Cold activation finds a completed effect and unanswered sibling | Preserve its result, interrupt the unfinished turn, and clear old requests |
| Client reattaches to the same live backend | Re-emit the existing valid request without restarting tools |
| Restart finds a reserved/unknown effect | Interrupt without replay; retain completed sibling results |
| All approvals answered before restart | Validate the absent pending projection, interrupt the orphan, and clear batch state |
| Approved Shell reaches its yield deadline | Commit its running handle; retain output, stop, and exit tracking in the manager |
| Runtime cleanup races a replacement binding | Conditional delete leaves the replacement registered |
| Two preparations request the same session | Share one initialization; other sessions proceed independently |
| Shutdown races initialization | Abort discovery; close late source results without publishing or starting later sources |
| A child waits for approval while its parent inspects an update | Parent adopts new content; child retains its original client and tool scope |
| A restored follow-up exists before runtime creation | Register the queue first, then repair delivery before any provider step |
| `close()` is called repeatedly | Return the same promise and execute each cleanup operation once |
| An early close operation fails | Continue later cleanup, then reject with the first failure |
| Artifact work is submitted after close starts | Reject it without extending the accepted drain prefix |
| Trace or derived artifact persistence fails | Contain the projection failure; do not rewrite canonical turn state |

### 5. Good/Base/Bad Cases

- Good: `Read`, `Read`, `Write`, `Read` delegates to one parallel read phase, one sequential write
  barrier, and one final read phase while persisting results in the original order.
- Good: two Shell calls have separate approvals; the second finishes first, but its durable tool
  result still follows the first. Neither can inherit its sibling's sandbox authority.
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
  `plugin-mcp-lifecycle.integration.test.ts` verifies real SDK/gateway child approval retention
  across independent parent updates, selected-session catalogs, and no extra clients on repeat
  resume. `node-backend.integration.test.ts` must retain the original follow-up text after reload.
- `parallel-approval-coordinator.test.ts` uses production SQLite storage to verify independent
  waiters, CAS rollback, identity checks, cancellation, frozen inputs, effect reuse, and unknown
  outcome recovery. Gateway/child/Worker tests verify live response forwarding and retained ownership.
- `m6-persistent-shell.integration.test.ts` submits two Shell calls in one provider response, approves
  and completes the second during the first's 30-second yield window, and asserts ordered unique
  wire outputs and final transcript records.
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

## Scenario: Root Interruption And Immediate Resubmission

### 1. Scope / Trigger

- Trigger: Esc/`turn.interrupt`, root Worker acquisition/release, forced cancellation, or startup
  failure after reserving a user turn.

### 2. Signatures

- `WorkerLeasedRootTurnRuntime.forceInterrupt(input, emit) -> Promise<RuntimeTurnRecord>`.
- `NodeTurnRuntime.failReservedTurn(reservation, error, emit, signal) -> Promise<RuntimeTurnRecord>`.
- `turn.interrupt({ turn_id })` returns acceptance only after the interrupted run's local ownership
  has been released or bounded recovery has replaced that ownership.

### 3. Contracts

- A terminal record and a released execution slot are separate facts. Publishing `turn.interrupted`
  alone does not make the root runtime available for a new submission.
- Cooperative interruption releases the existing Worker. Hard interruption fences the Worker,
  obtains a durable terminal result, and terminates that Worker before resolving the owned run with
  the terminal result. Do not require the old asynchronous operation to settle naturally afterward.
- The root wrapper resolves its release promise after clearing the exact active run and provider
  executor. Interruption acknowledgment waits for that promise. A late old result must never unbind
  or release a successor, and the gateway rejects old events by active-turn identity.
- The gateway must complete cleanup even when a terminal event arrived before its interruption
  grace timeout. A terminal event must not bypass the release barrier.
- If acquisition finishes after cancellation, release the acquired lease before binding an executor
  or invoking the turn. Setup exceptions after acquisition also pass through lease cleanup.
- Worker startup rejection after reservation goes through runtime terminalization. Cancellation is
  `interrupted`; an unclassified local startup failure is `config_error`; `StorageFailure` retains
  `persistence_error`. Existing durable terminal outcomes win. Raw exception text is not public data.
- Keep completed tool effects intact, close pending effects through existing terminalization, and
  never execute an uncertain effect automatically during interruption recovery.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Old operation remains pending after hard interruption | Settle the owned run with the durable result and accept a new root turn |
| Coordinator cleanup times out, recovery succeeds | Terminate the Worker and use the validated recovered interruption |
| Durable completion wins the cancellation race | Preserve completion and still dispose of the fenced Worker |
| Terminal event arrives while cleanup is pending | Keep interruption acknowledgment behind cleanup |
| Old callbacks arrive after a new turn begins | Ignore their projection and preserve the new executor and claim |
| Lease assignment completes after abort | Release it without provider dispatch |
| Worker startup fails after input reservation | Persist one terminal failure instead of leaving an in-progress reservation |

### 5. Good/Base/Bad Cases

- Good: Esc closes a streaming request; the interruption response is followed immediately by a
  successful `turn.submit`, without restarting the session.
- Base: cooperative cancellation reuses the same idle Worker on the next turn.
- Bad: return an interruption response while `#activeRun` still points to a hung operation, then
  translate every subsequent `root_agent_runtime_already_running` exception into a display-only
  persistence error.

### 6. Tests Required

- Hold the old operation pending through hard cancellation and start a second turn immediately.
- Exercise cleanup timeout with durable recovery and ensure the wrapper submission also settles.
- Deliver an old terminal callback during the second turn and check ownership/executor stability.
- Abort during lease assignment and assert zero delegate/provider calls and zero remaining leases.
- Reopen SQLite after startup failure/cancellation and check terminal records already exist.
- Run two real Worker/loopback-SSE interruption/follow-up cycles and check terminal events and
  provider-attempt records remain identical after reopen, without provider retries or orphan turns.

### 7. Wrong vs Correct

```typescript
// Wrong: a hung operation permanently retains the root runtime's admission state.
await terminateWorker();
return interruptedRecord;
```

```typescript
// Correct: resolve only after fencing, durable recovery, and Worker termination.
active.resolveForcedResult(interruptedRecord);
await active.released;
return interruptedRecord;
```

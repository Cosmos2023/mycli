# Node Runtime M5 State And Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Node-native session replay/resume, durable queue and approval continuation, context compaction, bounded memory, and fail-closed crash recovery while preserving Python/Node persistence compatibility.

**Architecture:** Extend the canonical contracts and pure core state machines first, then compose focused SQLite repositories and runtime coordinators behind the existing `SessionStore` and `NodeTurnRuntime`. Keep raw history canonical, make every queue/approval/compaction transition transactional or explicitly ambiguous, and reuse the current Node gateway/TUI event vocabulary without adding a second UI model.

**Tech Stack:** Node.js 22.19+, strict TypeScript/ESM, JSON Schema Draft 2020-12, Ajv, `json-schema-to-typescript`, `better-sqlite3`, `js-tiktoken`, Node filesystem APIs, Node test runner, pytest Python/Node parity fixtures.

---

## File Map

- Create `packages/contracts/schemas/runtime-state.schema.json`: canonical queue, approval, continuation, compaction, and session-state envelopes.
- Modify `packages/contracts/scripts/generate.mjs`: generate TypeScript and Python copies of the runtime-state schema.
- Modify `packages/contracts/src/validation.ts` and `packages/contracts/src/index.ts`: parse and export the new state contracts.
- Modify `packages/contracts/schemas/catalog.json` and `packages/contracts/schemas/gateway-events.schema.json`: add M5 stable errors and complete existing event payloads.
- Create `packages/core/src/queue-state.ts`: pure queue transitions, bounds, idempotency, and recovery normalization.
- Create `packages/core/src/approval-continuation.ts`: pure approval/effect checkpoint transitions.
- Create `packages/core/src/compaction-policy.ts`: pure token-budget and trigger decisions.
- Modify `packages/core/src/types.ts` and `packages/core/src/index.ts`: provider context fragments, new runtime events, and exports.
- Expand `packages/storage/src/session-store.ts`: typed catalog, state, replay, summary, checkpoint, and transactional transition interfaces.
- Create `packages/storage/src/sqlite-session-state.ts`: focused repository over the existing schema-v2 tables.
- Create `packages/storage/src/transcript-projector.ts`: canonical history to bounded TUI transcript projection and approval-resume normalization.
- Create `packages/storage/src/transcript-snapshot-store.ts`: schema-v1/v2 loading, atomic schema-v2 snapshots, and rebuild behavior.
- Modify `packages/storage/src/sqlite-session-store.ts`: compose the state repository and expose atomic M5 methods without duplicating SQL.
- Create `packages/runtime/src/session-coordinator.ts`: prepare/commit session generations and replay state.
- Create `packages/runtime/src/queue-coordinator.ts`: session-scoped queue persistence, safe-boundary commit, and draining.
- Create `packages/tools/src/approval-policy.ts`: injectable strict-medium policy over the existing manifests and workspace path policy.
- Create `packages/runtime/src/approval-continuation-coordinator.ts`: suspension, compare-and-set resolution, effect claims, and orphan recovery.
- Create `packages/runtime/src/provider-continuation.ts`: validate persisted Responses continuation and force canonical Chat replay.
- Create `packages/runtime/src/token-counter.ts`: `o200k_base` counting with the Python-compatible fallback.
- Create `packages/runtime/src/compaction-coordinator.ts`: trigger, summarize, replace, and bounded file rehydration.
- Create `packages/runtime/src/memory-store.ts`: workspace-keyed Markdown memory with atomic writes and symlink confinement.
- Create `packages/runtime/src/memory-selector.ts`: model JSON selection and deterministic local fallback.
- Create `packages/runtime/src/memory-context-service.ts`: session summary dedupe, injection, and explicit remember/forget.
- Modify `packages/config/src/settings.ts`: load and validate Python-compatible M5 memory/compaction settings.
- Modify `packages/runtime/src/node-turn-runtime.ts`: orchestrate fresh input, queues, compaction, memory, approval, and continuation.
- Modify `apps/mycli/src/node-runtime/node-backend.ts`: compose M5 repositories and coordinators per active session.
- Modify `apps/mycli/src/node-runtime/node-gateway.ts`: implement session, queue, approval, resume, and generation-aware event RPCs.
- Create `tests/fixtures/node_runtime_m5/state_recovery_contract.json`: cross-runtime state and recovery corpus.
- Create `tests/integration/node_runtime_m5_parity_helper.ts` and `tests/integration/test_node_runtime_m5_parity.py`: four-way persistence probes.
- Create `apps/mycli/test/m5-state-recovery.integration.test.ts`: complete Node-only M5 workflows.
- Create `scripts/smoke_node_m5_state.mjs`: sanitized opt-in live state/compaction/memory smoke.
- Modify `package.json`, package manifests, package-script tests, and `docs/node-runtime-rollout.md`: dependencies, M5 gates, rollout, and rollback.

### Task 1: Canonical M5 State Contracts

**Files:**
- Create: `packages/contracts/schemas/runtime-state.schema.json`
- Modify: `packages/contracts/scripts/generate.mjs`
- Modify: `packages/contracts/src/validation.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/schemas/catalog.json`
- Modify: `packages/contracts/schemas/gateway-events.schema.json`
- Test: `packages/contracts/test/runtime-state.test.ts`
- Test: `packages/contracts/test/catalog.test.ts`
- Test: `packages/contracts/test/fixtures.test.ts`

- [x] **Step 1: Write failing contract and drift tests**

Add fixtures that accept Python-compatible queue, pending approval, suspended turn, effect
checkpoint, compact checkpoint, and Responses continuation payloads, then reject cross-session
records, wrong root types, invalid enums, missing identities, and unsupported required versions:

```ts
test("parses a Python-compatible queue snapshot", () => {
	const state = parseRuntimeState({
		kind: "input_queue",
		version: 1,
		payload: {
			session_id: "s1",
			revision: 3,
			pending_steers: [queuedInput("q1", "pending_steer")],
			rejected_steers: [],
			follow_ups: [],
		},
	});
	assert.equal(state.kind, "input_queue");
});

test("rejects a queue record owned by another session", () => {
	assert.throws(
		() => parseRuntimeState(crossSessionQueueFixture()),
		ContractValidationError,
	);
});
```

Also assert the catalog contains `session_not_found`, `session_state_invalid`,
`session_state_version_unsupported`, `approval_not_pending`, and `approval_conflict`, and that all
generated files are drift-checked.

- [x] **Step 2: Run the contract tests and verify the missing parser failure**

Run: `node --import tsx --test packages/contracts/test/runtime-state.test.ts packages/contracts/test/catalog.test.ts packages/contracts/test/fixtures.test.ts`

Expected: FAIL because `runtime-state.schema.json` and `parseRuntimeState` do not exist.

- [x] **Step 3: Add the canonical schema and generator target**

Define one tagged validation envelope with closed variants and bounded strings/arrays:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mycli.local/schemas/runtime-state.schema.json",
  "title": "RuntimeStateRecord",
  "oneOf": [
    {"$ref": "#/$defs/input_queue"},
    {"$ref": "#/$defs/pending_decision"},
    {"$ref": "#/$defs/suspended_turn"},
    {"$ref": "#/$defs/effect_checkpoint"},
    {"$ref": "#/$defs/compact_checkpoint"},
    {"$ref": "#/$defs/responses_continuation"}
  ],
  "$defs": {
    "envelope_base": {
      "type": "object",
      "required": ["kind", "version", "payload"],
      "properties": {
        "kind": {"type": "string"},
        "version": {"const": 1},
        "payload": {"type": "object"}
      }
    }
  }
}
```

Expand each `$defs` variant with the exact design fields, `additionalProperties: true` only on
Python-compatible payloads that must preserve unknown optional fields, and explicit per-field
bounds. Add `["runtime-state.schema.json", "runtime-state-record.ts"]` to `targets` and copy the
schema to `src/mycli/schemas/generated`.

The envelope is a process-boundary validation shape, not a new SQLite payload. The repository maps
the existing `state_key` to `kind`, infers or reads version 1, validates
`{kind, version, payload: rawPayload}`, then stores `rawPayload` unchanged so Python continues to
read `input_queue`, `suspended_turn`, and other established keys.

- [x] **Step 4: Compile, export, and validate the schema**

Add the validator and export:

```ts
const validateRuntimeState = compile("runtime-state.schema.json");

export function parseRuntimeState(value: unknown): RuntimeStateRecord {
	return parse(value, validateRuntimeState, "runtime state");
}
```

Update the event schema so `session.changed`, `turn.queue.updated`, `approval.request`,
`approval.respond`, `compaction.started`, and `compaction.completed` carry bounded generation,
revision, decision, checkpoint, and count fields while retaining compatible optional legacy
fields.

- [x] **Step 5: Generate contracts and run the package gate**

Run: `npm run contracts:generate && npm run test --workspace @mycli/contracts && npm run contracts:check && npm run typecheck --workspace @mycli/contracts`

Expected: generated TypeScript/Python files are stable; tests and drift check pass.

- [x] **Step 6: Commit the M5 contract boundary**

```bash
git add packages/contracts src/mycli/schemas/generated
git commit -m "feat(node-contracts): define M5 runtime state"
```

### Task 2: Pure Queue, Approval, And Compaction State Machines

**Files:**
- Create: `packages/core/src/queue-state.ts`
- Create: `packages/core/src/approval-continuation.ts`
- Create: `packages/core/src/compaction-policy.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/queue-state.test.ts`
- Test: `packages/core/test/approval-continuation.test.ts`
- Test: `packages/core/test/compaction-policy.test.ts`

- [x] **Step 1: Write failing queue transition tests**

```ts
test("accepts a steer only for the expected active turn", () => {
	const result = enqueueSteer(emptyQueue("s1"), {
		queueId: "q1", clientTurnId: "c1", expectedTurnId: "t1",
		activeTurnId: "t1", steerable: true, text: "inspect output", source: "user",
		now: "2026-08-04T00:00:00Z",
	});
	assert.equal(result.disposition, "accepted_for_turn");
	assert.equal(result.snapshot.pendingSteers[0]?.queueId, "q1");
});

test("reconciles committed queue ids without delivering them again", () => {
	const restored = restoreQueue(pendingQueue("q1", "t1"), {
		committedQueueIds: new Set(["q1"]), activeTurnId: null,
	});
	assert.equal(restored.pendingSteers.length, 0);
});
```

Cover duplicate/same-payload success, duplicate/different-payload conflict, stale turns,
rejected-before-follow-up priority, capacity, pop-last-follow-up, clear, terminal rejection,
revision increments, and cross-session rejection.

- [x] **Step 2: Write failing approval and compaction decision tests**

```ts
test("effect claims cannot return to approved", () => {
	const claimed = transitionApproval(waitingApproval(), { type: "approve_once" });
	const executing = transitionApproval(claimed, { type: "claim_effect", fingerprint: "sha256:a" });
	assert.throws(() => transitionApproval(executing, { type: "approve_once" }), ApprovalConflictError);
});

test("compacts only when the usable input budget is crossed", () => {
	assert.deepEqual(decideCompaction({ usedTokens: 90, tokenLimit: 100, reservedOutputTokens: 20 }), {
		shouldCompact: true, reason: "context_limit",
	});
});
```

- [x] **Step 3: Run the core tests and verify missing-module failures**

Run: `node --import tsx --test packages/core/test/queue-state.test.ts packages/core/test/approval-continuation.test.ts packages/core/test/compaction-policy.test.ts`

Expected: FAIL because the three modules are missing.

- [x] **Step 4: Implement immutable state transitions and bounds**

Use frozen records and pure functions. The public queue result shape is:

```ts
export interface QueueSnapshot {
	readonly sessionId: string;
	readonly revision: number;
	readonly pendingSteers: readonly QueuedInput[];
	readonly rejectedSteers: readonly QueuedInput[];
	readonly followUps: readonly QueuedInput[];
}

export function nextQueuedInput(snapshot: QueueSnapshot): QueuedInput | undefined {
	return snapshot.rejectedSteers[0] ?? snapshot.followUps[0];
}
```

Approval states are `waiting`, `approved`, `executing`, `completed`, and `rejected`; only the
documented transitions are accepted. Compaction decisions use finite non-negative integers,
clamped ratios, and never compact a fresh suffix.

- [x] **Step 5: Run core tests and typecheck**

Run: `npm run test --workspace @mycli/core && npm run typecheck --workspace @mycli/core`

Expected: all core tests pass.

- [x] **Step 6: Commit the pure M5 state machines**

```bash
git add packages/core
git commit -m "feat(node-core): model recoverable runtime state"
```

### Task 3: Session Catalog And Atomic State Repository

**Files:**
- Modify: `packages/storage/src/session-store.ts`
- Create: `packages/storage/src/sqlite-session-state.ts`
- Modify: `packages/storage/src/sqlite-session-store.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/session-state.test.ts`
- Test: `packages/storage/test/sqlite-session-store.test.ts`

- [x] **Step 1: Write failing catalog, state, summary, and transaction tests**

```ts
test("lists sessions by last activity with compatible counts", (t) => {
	const store = stateStoreFixture(t);
	seedSession(store, "older", "2026-08-03T00:00:00Z");
	seedSession(store, "newer", "2026-08-04T00:00:00Z");
	assert.deepEqual(store.listSessions({ limit: 20 }).map((item) => item.sessionId), ["newer", "older"]);
});

test("rolls back queue history and removal together", (t) => {
	const store = stateStoreFixture(t, { failpoint: "queue_commit_after_history" });
	seedPendingSteer(store, "s1", "q1");
	assert.throws(() => store.commitQueuedInputs(queueCommit("s1", "q1")), StorageFailure);
	assert.equal(store.loadHistoryItems("s1").some(hasQueueId("q1")), false);
	assert.equal(store.loadQueueSnapshot("s1").pendingSteers.length, 1);
});
```

Also test state save/load/delete, wrong-root rejection, unknown-field preservation, summary order,
lineage, committed queue IDs, approval compare-and-set, effect claim/result, compact replacement,
and an existing Python-created schema-v2 database.

- [x] **Step 2: Run storage tests and verify interface failures**

Run: `node --import tsx --test packages/storage/test/session-state.test.ts packages/storage/test/sqlite-session-store.test.ts`

Expected: FAIL because the M5 `SessionStore` methods do not exist.

- [x] **Step 3: Define focused storage interfaces**

Add typed methods without exposing SQL rows:

```ts
export interface SessionStateStore {
	listSessions(query: SessionListQuery): readonly SessionOverview[];
	loadSession(sessionId: string): SessionOverview | undefined;
	loadState(sessionId: string, key: RuntimeStateKey): unknown | undefined;
	saveState(input: SaveStateInput): void;
	deleteState(sessionId: string, key: RuntimeStateKey): void;
	appendSessionSummary(input: AppendSessionSummaryInput): void;
	loadSessionSummaries(sessionId: string): readonly string[];
	commitQueuedInputs(input: CommitQueuedInputsInput): QueueSnapshot;
	compareAndSetApproval(input: ApprovalTransitionInput): ApprovalCheckpoint;
	commitCompaction(input: CommitCompactionInput): void;
}
```

`SessionStore` extends this interface plus its existing turn APIs.
`RuntimeStateKey` includes the existing Python keys plus additive `node_effect_checkpoint`; Python
may ignore that key, but Node recovery must consult it before exposing a pending approval.

- [x] **Step 4: Implement `SQLiteSessionStateRepository` and delegate from the store**

Construct the repository with the initialized `better-sqlite3` handle and the existing clock. Use
`BEGIN IMMEDIATE` only through the store's shared transaction wrapper. Parse JSON with source-key
diagnostics, validate known state through `parseRuntimeState`, preserve compatible optional fields,
and return immutable domain objects.

The queue commit transaction must insert canonical/history user records containing `queue_id` and
remove those exact pending records. The compaction transaction replaces only
`conversation_messages`, appends `session_summaries`, saves `compact_checkpoint`, and invalidates
Responses continuation.

- [x] **Step 5: Run storage tests, schema tests, and typecheck**

Run: `npm run test --workspace @mycli/storage && npm run typecheck --workspace @mycli/storage`

Expected: all storage tests pass without schema version drift.

- [x] **Step 6: Commit the M5 state repository**

```bash
git add packages/storage
git commit -m "feat(node-storage): add atomic session state APIs"
```

### Task 4: Transcript Projection And Readable Snapshots

**Files:**
- Create: `packages/storage/src/transcript-projector.ts`
- Create: `packages/storage/src/transcript-snapshot-store.ts`
- Modify: `packages/storage/src/session-store.ts`
- Modify: `packages/storage/src/sqlite-session-state.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/transcript-projector.test.ts`
- Test: `packages/storage/test/transcript-snapshot-store.test.ts`

- [x] **Step 1: Write failing projection and approval normalization tests**

```ts
test("suppresses only legacy synthetic approval-resume user rows", () => {
	const projected = projectTranscript(approvalResumeHistoryFixture(), approvalRolloutFixture());
	assert.deepEqual(projected.filter((item) => item.type === "user_message").map(textOf), ["change it"]);
});

test("keeps independent repeated and queued user messages", () => {
	const projected = projectTranscript(repeatedAndQueuedFixture(), approvalRolloutFixture());
	assert.deepEqual(projected.filter((item) => item.type === "user_message").map(textOf), [
		"change it", "change it", "queued follow-up",
	]);
});
```

Cover stable tool IDs, file changes, 8,000-character head/tail bounds, raw reasoning exclusion,
unknown visible fallback, pagination after normalization, and provider metadata exclusion.

- [x] **Step 2: Write failing snapshot atomicity and migration tests**

```ts
test("rebuilds a corrupt v2 snapshot from SQLite", async (t) => {
	const fixture = snapshotFixture(t);
	await writeFile(fixture.path, "{bad", "utf8");
	const result = await fixture.snapshots.loadOrRebuild("s1", fixture.project);
	assert.equal(result.source, "sqlite_rebuild");
	assert.equal(JSON.parse(await readFile(fixture.path, "utf8")).schema_version, 2);
});
```

Also prove SQLite failure exposes snapshot history as read-only, v1 imports only when canonical
data is absent, failed migration preserves v1 bytes, and temp-write failure preserves the old v2.

- [x] **Step 3: Run targeted tests and verify missing-module failures**

Run: `node --import tsx --test packages/storage/test/transcript-projector.test.ts packages/storage/test/transcript-snapshot-store.test.ts`

Expected: FAIL because both modules are missing.

- [x] **Step 4: Implement the projector and atomic snapshot store**

Expose a bounded display contract independent of provider history:

```ts
export interface TranscriptSnapshotV2 {
	readonly schema_version: 2;
	readonly session_id: string;
	readonly cwd: string;
	readonly state: "idle" | "running" | "waiting_approval" | "interrupted";
	readonly message_count: number;
	readonly created_at: string;
	readonly updated_at: string;
	readonly transcript: readonly TranscriptItem[];
}
```

Write UTF-8 `JSON.stringify(snapshot, null, 2) + "\n"` to an exclusive sibling temp file, sync,
rename, and clean up on failure. Never read the snapshot to construct provider context.

- [x] **Step 5: Run storage and snapshot tests**

Run: `npm run test --workspace @mycli/storage && npm run typecheck --workspace @mycli/storage`

Expected: PASS.

- [x] **Step 6: Commit transcript replay and snapshots**

```bash
git add packages/storage
git commit -m "feat(node-storage): restore bounded session transcripts"
```

### Task 5: Session Coordinator And Atomic Gateway Resume

**Files:**
- Create: `packages/runtime/src/session-coordinator.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `apps/mycli/src/node-runtime/node-gateway.ts`
- Modify: `apps/mycli/src/node-runtime/node-backend.ts`
- Test: `packages/runtime/test/session-coordinator.test.ts`
- Test: `apps/mycli/test/node-gateway.test.ts`

- [x] **Step 1: Write failing prepare/commit generation tests**

```ts
test("failed target preparation leaves the source session active", async () => {
	const coordinator = sessionCoordinatorFixture({ targetFailure: "session_state_invalid" });
	await assert.rejects(() => coordinator.resume("target"), hasCode("session_state_invalid"));
	assert.equal(coordinator.snapshot().sessionId, "source");
	assert.equal(coordinator.snapshot().generation, 1);
});

test("a successful resume replaces all session-scoped state in one generation", async () => {
	const coordinator = sessionCoordinatorFixture();
	const result = await coordinator.resume("target");
	assert.equal(result.generation, 2);
	assert.equal(result.queue.sessionId, "target");
	assert.equal(result.pendingApproval?.sessionId, "target");
});
```

Cover same-session idempotency, unknown session, active-turn rejection, read-only degraded replay,
stale generation filtering, and lineage/tree loading.

- [x] **Step 2: Write failing gateway session RPC tests**

Exercise `session.list`, `session.resume`, `session.tree`, `transcript.load`, and bootstrap. Assert
one `session.changed` precedes the target queue/approval projection and no target event is emitted
when preparation fails.

- [x] **Step 3: Run runtime and gateway tests and verify missing coordinator failures**

Run: `node --import tsx --test packages/runtime/test/session-coordinator.test.ts apps/mycli/test/node-gateway.test.ts`

Expected: FAIL because `SessionCoordinator` and M5 RPC handlers do not exist.

- [x] **Step 4: Implement prepare/commit resume and generation guards**

```ts
export class SessionCoordinator {
	#snapshot: ActiveSessionSnapshot;

	async resume(sessionId: string): Promise<ActiveSessionSnapshot> {
		if (this.#snapshot.executing) throw new SessionTransitionError("turn_in_progress");
		if (sessionId === this.#snapshot.sessionId) return this.#snapshot;
		const prepared = await this.#prepare(sessionId);
		this.#snapshot = Object.freeze({ ...prepared, generation: this.#snapshot.generation + 1 });
		return this.#snapshot;
	}
}
```

Gateway event callbacks capture `{sessionId, generation}` and ignore late mismatches. Make
`#options.sessionId` dynamic through the coordinator rather than mutating the original options.

- [x] **Step 5: Run gateway, app, and runtime gates**

Run: `npm run test --workspace @mycli/runtime && npm run test --workspace @mycli/app && npm run typecheck --workspace @mycli/runtime && npm run typecheck --workspace @mycli/app`

Expected: PASS.

- [x] **Step 6: Commit atomic session resume**

```bash
git add packages/runtime apps/mycli
git commit -m "feat(node-runtime): add atomic session resume"
```

### Task 6: Durable Queue And Steering

**Files:**
- Create: `packages/runtime/src/queue-coordinator.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/src/node-turn-runtime.ts`
- Modify: `apps/mycli/src/node-runtime/node-gateway.ts`
- Test: `packages/runtime/test/queue-coordinator.test.ts`
- Test: `packages/runtime/test/node-turn-runtime.test.ts`
- Test: `apps/mycli/test/node-gateway.test.ts`

- [x] **Step 1: Write failing coordinator persistence tests**

```ts
test("does not publish a queue revision before persistence", () => {
	const fixture = queueCoordinatorFixture({ failSave: true });
	assert.throws(() => fixture.coordinator.enqueueFollowUp(followUp("c1")), StorageFailure);
	assert.deepEqual(fixture.events, []);
});

test("commits accepted steers to history exactly once", () => {
	const fixture = queueCoordinatorFixture();
	fixture.coordinator.enqueueSteer(acceptedSteer("q1", "t1"));
	fixture.coordinator.commitPending("t1");
	fixture.coordinator.commitPending("t1");
	assert.equal(fixture.history.filter(hasQueueId("q1")).length, 1);
});
```

Cover restore normalization, terminal rejection, interrupt retention, rejected-first draining,
session isolation, duplicate lost-response retry, pop, clear, migration ack, and capacity errors.

- [x] **Step 2: Write failing gateway queue RPC/event tests**

Verify `turn.steer`, `turn.follow_up`, follow-up submission racing with turn completion, `turn.queue.pop`,
`turn.queue.clear`, and migration ack return matching revisions and structured snapshots. Assert
legacy arrays are projections and stale expected turn IDs become rejected records rather than lost
input.

- [x] **Step 3: Run targeted tests and verify missing coordinator failures**

Run: `node --import tsx --test packages/runtime/test/queue-coordinator.test.ts packages/runtime/test/node-turn-runtime.test.ts apps/mycli/test/node-gateway.test.ts`

Expected: FAIL because queue orchestration is not wired.

- [x] **Step 4: Implement persistent queue orchestration**

```ts
export class QueueCoordinator {
	enqueueSteer(input: EnqueueSteerInput): QueueMutation {
		const mutation = enqueueSteer(this.#snapshot, input);
		this.#store.saveQueueSnapshot(mutation.snapshot);
		this.#publish(mutation.snapshot);
		this.#snapshot = mutation.snapshot;
		return mutation;
	}

	commitPending(turnId: string): readonly QueuedInput[] {
		const claimed = claimPendingSteers(this.#snapshot, turnId);
		this.#snapshot = this.#store.commitQueuedInputs({ sessionId: this.#sessionId, records: claimed });
		this.#publish(this.#snapshot);
		return claimed;
	}
}
```

Commit steers before request projection, preserve the freshly committed records outside compaction
summary input, and reserve at most one queued next turn after terminal completion.

- [x] **Step 5: Run queue, runtime, gateway, and TUI regression tests**

Run: `npm run test --workspace @mycli/runtime && npm run test --workspace @mycli/app && npm run test --workspace mycli-shell-tui`

Expected: PASS.

- [x] **Step 6: Commit durable queue and steering**

```bash
git add packages/runtime apps/mycli
git commit -m "feat(node-runtime): persist queue and steering state"
```

### Task 7: One-Time Approval Continuation And Effect Claims

**Files:**
- Create: `packages/tools/src/approval-policy.ts`
- Modify: `packages/tools/src/index.ts`
- Create: `packages/runtime/src/approval-continuation-coordinator.ts`
- Modify: `packages/runtime/src/node-turn-runtime.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `apps/mycli/src/node-runtime/node-gateway.ts`
- Test: `packages/tools/test/approval-policy.test.ts`
- Test: `packages/runtime/test/approval-continuation-coordinator.test.ts`
- Test: `packages/runtime/test/node-turn-runtime.test.ts`
- Test: `apps/mycli/test/node-gateway.test.ts`

- [x] **Step 1: Write failing policy tests**

```ts
test("default policy auto-allows a valid workspace mutation", () => {
	assert.equal(policy({ autoApproveMedium: true }).evaluate(writeCall("notes.txt")).kind, "allow");
});

test("strict-medium requests one-time approval without allowing workspace escape", () => {
	assert.equal(policy({ autoApproveMedium: false }).evaluate(writeCall("notes.txt")).kind, "request");
	assert.equal(policy({ autoApproveMedium: false }).evaluate(writeCall("../outside")).kind, "deny");
});
```

Assert content previews are bounded and secret-like bodies, hashes, and real paths are absent.

- [x] **Step 2: Write failing suspension, resolution, and crash tests**

```ts
test("restores an unambiguous waiting approval after restart", () => {
	const first = approvalFixture();
	first.coordinator.suspend(pendingWrite("call_1"));
	const reopened = first.reopen();
	assert.equal(reopened.pending()?.callId, "call_1");
});

test("never re-executes an orphaned claimed effect", async () => {
	const fixture = approvalFixture({ persistedState: executingCheckpoint("call_1") });
	await fixture.coordinator.recover();
	assert.equal(fixture.executeCalls, 0);
	assert.equal(fixture.turn.errorKind, "effect_outcome_unknown");
});
```

Cover approve once, reject, repeat-identical response, conflicting response, wrong decision ID,
multiple approvals in one batch, original-user dedupe, completed effect, and interrupt during tool
execution.

- [x] **Step 3: Run approval tests and verify missing components**

Run: `node --import tsx --test packages/tools/test/approval-policy.test.ts packages/runtime/test/approval-continuation-coordinator.test.ts packages/runtime/test/node-turn-runtime.test.ts apps/mycli/test/node-gateway.test.ts`

Expected: FAIL because policy and continuation coordinator are missing.

- [x] **Step 4: Implement suspension and effect checkpoints**

```ts
export type ApprovalResolution =
	| { readonly status: "waiting"; readonly decisionId: string }
	| { readonly status: "rejected"; readonly decisionId: string }
	| { readonly status: "approved"; readonly decisionId: string }
	| { readonly status: "executing"; readonly decisionId: string; readonly fingerprint: string }
	| { readonly status: "completed"; readonly decisionId: string; readonly resultCallId: string };
```

Persist assistant calls before evaluation. Save compatible `pending_decision`, `suspended_turn`,
and `turn_record` before emitting `approval.request`. On approval, CAS to approved, CAS to
executing, invoke the existing router once, then append result and mark completed in one SQLite
transaction. On orphaned executing state, append an interrupted result/rollout and never call the
router.

- [x] **Step 5: Implement `approval.respond` and provider batch continuation**

Gateway accepts only `approve_once` and `reject` for Node M5, locks to the active generation and
owning backend, emits the existing approval events, and lets `NodeTurnRuntime` resume remaining
calls in their original order without appending another user message.

- [x] **Step 6: Run tool, runtime, gateway, and M4 regressions**

Run: `npm run test --workspace @mycli/tools && npm run test --workspace @mycli/runtime && npm run test --workspace @mycli/app && npm run test:m4`

Expected: PASS.

- [x] **Step 7: Commit approval continuation**

```bash
git add packages/tools packages/runtime apps/mycli
git commit -m "feat(node-runtime): resume one-time approvals safely"
```

### Task 8: Token Counter, Configuration, And Compaction Pipeline

**Files:**
- Modify: `packages/runtime/package.json`
- Modify: `package-lock.json`
- Modify: `packages/config/src/settings.ts`
- Test: `packages/config/test/settings.test.ts`
- Modify: `packages/core/src/types.ts`
- Test: `packages/providers/test/openai-provider-registry.test.ts`
- Create: `packages/runtime/src/token-counter.ts`
- Create: `packages/runtime/src/compaction-coordinator.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/src/node-turn-runtime.ts`
- Test: `packages/runtime/test/token-counter.test.ts`
- Test: `packages/runtime/test/compaction-coordinator.test.ts`
- Modify: `apps/mycli/src/node-runtime/node-backend.ts`
- Modify: `apps/mycli/src/node-runtime/node-gateway.ts`
- Test: `apps/mycli/test/node-gateway.test.ts`

- [x] **Step 1: Write failing config and token fixture tests**

```ts
test("loads compatible compaction and memory defaults", async () => {
	const config = await resolveFixtureConfig({});
	assert.equal(config.compactionTailTurns, 2);
	assert.equal(config.compactionTailMaxTokens, 8_000);
	assert.equal(config.memoryEnabled, true);
});

test("uses the Python fallback estimate when encoder loading fails", () => {
	const counter = new TokenCounter({ loadEncoder: () => { throw new Error("unavailable"); } });
	assert.equal(counter.count("abcd中"), 2);
});
```

Add a fixed ASCII/CJK/mixed/code/tool-output corpus whose expected counts come from Python's
`TokenCounter` with `o200k_base`.

- [x] **Step 2: Write failing compaction transaction tests**

```ts
test("keeps current input out of the summary and preserves raw history", async () => {
	const fixture = compactionFixture({ overLimit: true });
	await fixture.coordinator.compact({ freshItemIds: new Set(["current-user", "steer-q1"]) });
	assert.doesNotMatch(fixture.summaryPrompt, /current request/);
	assert.equal(fixture.rawHistory.length, fixture.originalRawHistoryLength);
});

test("does not publish completion when replacement persistence fails", async () => {
	const fixture = compactionFixture({ failCommit: true });
	await assert.rejects(() => fixture.coordinator.compact({ freshItemIds: new Set() }));
	assert.deepEqual(fixture.events.map((event) => event.type), ["compaction_started"]);
	assert.deepEqual(fixture.providerConversation, fixture.originalConversation);
});
```

Cover threshold/buffer/reserved output, tail turns/tokens, minimum savings, summary failure,
in-progress restart, context-overflow retry before output, no retry after output, continuation
invalidation, and rehydration path/token/count bounds.

- [x] **Step 3: Run targeted tests and verify missing dependency/modules**

Run: `node --import tsx --test packages/config/test/settings.test.ts packages/runtime/test/token-counter.test.ts packages/runtime/test/compaction-coordinator.test.ts`

Expected: FAIL because M5 config fields and runtime modules are missing.

- [x] **Step 4: Install and lock `js-tiktoken`**

Run: `npm_config_cache=/tmp/mycli-npm-cache npm install js-tiktoken@^1.0.21 --workspace @mycli/runtime`

Expected: only `packages/runtime/package.json` and `package-lock.json` gain the package and its
declared dependency closure.

- [x] **Step 5: Implement compatible config and token counting**

```ts
export class TokenCounter {
	readonly #encode: ((text: string) => readonly number[]) | undefined;
	count(text: string): number {
		if (!text) return 0;
		if (this.#encode) return this.#encode(text).length;
		let ascii = 0;
		for (const char of text) if (char.codePointAt(0)! <= 127) ascii += 1;
		return Math.max(1, Math.ceil(ascii / 4) + [...text].length - ascii);
	}
}
```

Load `o200k_base`, cache bounded counts, and close/free encoder resources if the package requires
it. Parse all documented settings with finite range validation.

- [x] **Step 6: Implement compaction and file rehydration**

Use the existing provider abstraction for a bounded summary request. Persist an in-progress
fingerprint before IO. After success, call the one storage `commitCompaction()` transaction and
emit completion. Re-read candidate files through the M4 real-workspace policy, prefer edits over
reads, skip state/memory paths and tail duplicates, and apply item/total/count limits.

- [x] **Step 7: Run config/runtime tests and typecheck**

Run: `npm run test --workspace @mycli/config && npm run test --workspace @mycli/runtime && npm run typecheck --workspace @mycli/config && npm run typecheck --workspace @mycli/runtime`

Expected: PASS.

- [x] **Step 8: Commit compaction support**

```bash
git add apps/mycli/src/node-runtime/node-backend.ts \
  apps/mycli/src/node-runtime/node-gateway.ts \
  apps/mycli/test/node-gateway.test.ts \
  packages/config packages/core/src/types.ts \
  packages/providers/test/openai-provider-registry.test.ts \
  packages/runtime package-lock.json
git commit -m "feat(node-runtime): compact recoverable session context"
```

### Task 9: Workspace Memory And Session Summaries

**Files:**
- Create: `packages/runtime/src/memory-store.ts`
- Create: `packages/runtime/src/memory-ordering.ts`
- Create: `packages/runtime/src/memory-selector.ts`
- Create: `packages/runtime/src/memory-context-service.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/src/node-turn-runtime.ts`
- Test: `packages/runtime/test/memory-store.test.ts`
- Test: `packages/runtime/test/memory-selector.test.ts`
- Test: `packages/runtime/test/memory-context-service.test.ts`

- [x] **Step 1: Write failing memory layout, bounds, and escape tests**

```ts
test("derives the Python-compatible memory directory from the real workspace", async (t) => {
	const fixture = memoryFixture(t);
	assert.equal(
		await fixture.store.root(),
		join(fixture.home, ".mycli", "projects", fixture.pythonWorkspaceKey, "memory"),
	);
});

test("rejects a topic symlink that escapes the memory root", async (t) => {
	const fixture = memoryFixture(t);
	await fixture.escapeTopic("outside.md");
	await assert.rejects(() => fixture.store.loadTopic("outside.md"), hasKind("memory_path_escape"));
});
```

Cover 200 topics, 200/25,000 index bounds, 30-line frontmatter, valid kinds, UTF-8, unique names,
atomic topic/index writes, temp cleanup, exact forget, bounded relevant forget, and no secret body
logging.

- [x] **Step 2: Write failing selection, fallback, and injection tests**

```ts
test("falls back to deterministic local selection on invalid model JSON", async () => {
	const service = memoryServiceFixture({ selectorResponse: "not json" });
	const selected = await service.select("concise replies");
	assert.deepEqual(selected.map((item) => item.filename), ["tone.md"]);
});

test("deduplicates file memory and session summaries", async () => {
	const service = memoryServiceFixture({ duplicateSummary: true });
	const context = await service.collect("s1", "continue");
	assert.equal(context.records.filter((record) => /concise/.test(record.value)).length, 1);
});
```

Assert no selector call for empty memory/query, at most five validated filenames, disabled mode,
bounded token injection, and memory fragments absent from canonical history.

- [x] **Step 3: Write failing explicit remember/forget tests**

```ts
test("handles explicit remember only after a successful turn", async () => {
	const service = memoryServiceFixture();
	await service.afterSuccessfulTurn("remember that I prefer terse final answers");
	assert.equal((await service.store.scan()).length, 1);
	await service.afterFailedTurn("remember that this should not persist");
	assert.equal((await service.store.scan()).length, 1);
});
```

- [x] **Step 4: Run memory tests and verify missing modules**

Run: `node --import tsx --test packages/runtime/test/memory-store.test.ts packages/runtime/test/memory-selector.test.ts packages/runtime/test/memory-context-service.test.ts`

Expected: FAIL because the memory modules do not exist.

- [x] **Step 5: Implement the dedicated memory adapter and selector**

```ts
export interface MemoryRecord {
	readonly kind: "session_summary" | "user" | "feedback" | "project" | "reference";
	readonly key: string;
	readonly value: string;
	readonly tags: readonly string[];
}
```

Derive the workspace key byte-for-byte like Python, resolve the real memory root, never pass
model-returned paths to filesystem APIs, write sibling temp files with sync/rename, and implement
the Python weighted token/recency fallback. Use the existing provider interface for JSON-only model
selection and cap output at 512 tokens.

- [x] **Step 6: Integrate summaries, request fragments, and explicit actions**

Load summaries through `SessionStore`, dedupe normalized triples, inject bounded memory after
rehydration and before fresh input, then perform direct explicit remember/forget only after a
successful terminal turn. Do not create background jobs or subagents.

- [x] **Step 7: Run runtime memory tests and typecheck**

Run: `npm run test --workspace @mycli/runtime && npm run typecheck --workspace @mycli/runtime`

Expected: PASS.

- [ ] **Step 8: Commit Node memory support**

```bash
git add packages/runtime
git commit -m "feat(node-runtime): add bounded workspace memory"
```

### Task 10: End-To-End Runtime Composition And Request Ordering

**Files:**
- Modify: `packages/core/src/request-projection.ts`
- Create: `packages/runtime/src/provider-continuation.ts`
- Modify: `packages/runtime/src/node-turn-runtime.ts`
- Modify: `apps/mycli/src/node-runtime/node-backend.ts`
- Modify: `apps/mycli/src/node-runtime/node-gateway.ts`
- Test: `packages/core/test/request-projection.test.ts`
- Test: `packages/runtime/test/provider-continuation.test.ts`
- Test: `packages/runtime/test/node-turn-runtime.test.ts`
- Test: `apps/mycli/test/node-backend.integration.test.ts`
- Test: `apps/mycli/test/node-gateway.test.ts`

- [ ] **Step 1: Write failing request-fragment ordering tests**

```ts
test("orders compacted replay, rehydration, memory, and fresh input", () => {
	const request = projectProviderRequest(m5ProjectionFixture());
	assert.deepEqual(request.items?.map(itemLabel), [
		"compacted-summary", "tail", "rehydration", "memory", "current-user", "steer-q1",
	]);
});
```

Assert equivalent model visibility for Responses and Chat, current input appears exactly once,
memory is not durable history, and tool calls/results retain order.

- [ ] **Step 2: Write failing complete lifecycle tests**

Cover reserve -> queue commit -> compaction -> memory -> provider -> approval/tool -> continuation
-> terminal persistence -> snapshot -> explicit memory -> queue drain. Inject failures at each
stage and assert stable terminal state plus no Python start.

- [ ] **Step 3: Run core/runtime/app tests and verify orchestration failures**

Run: `node --import tsx --test packages/core/test/request-projection.test.ts packages/runtime/test/provider-continuation.test.ts packages/runtime/test/node-turn-runtime.test.ts apps/mycli/test/node-backend.integration.test.ts apps/mycli/test/node-gateway.test.ts`

Expected: FAIL until continuation validation and the composition root supply all coordinators.

- [ ] **Step 4: Refactor `NodeTurnRuntime` into explicit phase helpers**

Keep the public API stable, but replace the monolithic body with focused private collaborators:

```ts
const prepared = await this.#prepareTurn(submission, reservation, context);
const providerResult = await this.#runProviderLoop(prepared, context);
return this.#finalizePreparedTurn(prepared, providerResult, context);
```

`#prepareTurn` records the fresh item IDs before compaction. `#runProviderLoop` delegates approval
without special-casing tool names. Finalization writes snapshot before memory diagnostics and
drains at most one next queued input.

- [ ] **Step 5: Implement provider continuation validation**

```ts
export function selectProviderContinuation(input: ContinuationInput): ContinuationDecision {
	if (input.protocol !== "responses") return { kind: "canonical_replay", reason: "chat_replay" };
	if (!input.persisted?.eligible) return { kind: "canonical_replay", reason: "ineligible" };
	if (input.persisted.request_signature !== input.requestSignature
		|| input.persisted.model !== input.model
		|| input.persisted.history_boundary !== input.historyBoundary) {
		return { kind: "canonical_replay", reason: "state_mismatch" };
	}
	return { kind: "responses_continuation", responseId: input.persisted.response_id };
}
```

Persist Responses response ID, request signature, model/protocol, history boundary, and eligibility
after each safe provider completion. Compaction, provider rejection, malformed state, and
ambiguous effects clear eligibility. Chat never consumes a response ID.

- [ ] **Step 6: Compose per-session services in the Node backend**

Construct one SQLite store, snapshot store, session coordinator, queue coordinator factory,
approval coordinator, compaction coordinator, memory service, and tool router. Session resume must
rebind session-scoped coordinators without rebuilding provider-independent global services.

- [ ] **Step 7: Run package and M4 regressions**

Run: `npm run test --workspace @mycli/core && npm run test --workspace @mycli/runtime && npm run test --workspace @mycli/app && npm run test:m4`

Expected: PASS.

- [ ] **Step 8: Commit M5 runtime composition**

```bash
git add packages/core packages/runtime apps/mycli
git commit -m "feat(node-runtime): compose M5 stateful turns"
```

### Task 11: Crash Injection And Four-Way Python/Node Parity

**Files:**
- Create: `tests/fixtures/node_runtime_m5/state_recovery_contract.json`
- Create: `tests/integration/node_runtime_m5_parity_helper.ts`
- Create: `tests/integration/test_node_runtime_m5_parity.py`
- Modify: `packages/storage/test/recovery.test.ts`
- Create: `packages/runtime/test/m5-fault-injection.test.ts`

- [ ] **Step 1: Define the sanitized parity and failpoint corpus**

The JSON fixture enumerates state cases with writer, reader, state key, expected normalized value,
and expected failure/recovery:

```json
{
  "version": 1,
  "cases": [
    {"id": "queue-pending", "state_key": "input_queue", "expect": "pending_once"},
    {"id": "approval-waiting", "state_key": "suspended_turn", "expect": "reemit_choice"},
    {"id": "effect-executing", "state_key": "node_effect_checkpoint", "expect": "interrupt_unknown"},
    {"id": "compact-complete", "state_key": "compact_checkpoint", "expect": "replacement_visible"},
    {"id": "responses-ineligible", "state_key": "responses_continuation_state", "expect": "full_replay"}
  ]
}
```

Include catalog/replay/summaries, valid unknown optional fields, malformed root types, unsupported
versions, legacy approval duplicates, and queue history reconciliation.

- [ ] **Step 2: Write the failing four-way pytest matrix**

```py
@pytest.mark.parametrize("writer,reader", [
    ("python", "python"), ("python", "node"),
    ("node", "python"), ("node", "node"),
])
def test_m5_state_round_trip(writer: str, reader: str, tmp_path: Path) -> None:
    result = run_case_matrix(writer=writer, reader=reader, db_path=tmp_path / "sessions.db")
    assert result["failed"] == []
```

- [ ] **Step 3: Write failing crash-boundary tests**

Inject before/after reservation, queue save/response, queue history/removal, approval suspension,
approval resolution, effect claim, filesystem commit, tool result, summary request, compact commit,
snapshot rename, memory topic/index, and session prepare/commit. Each test asserts one user item,
one queue commit, at most one effect/result, no automatic provider replay, and session isolation.

- [ ] **Step 4: Run parity and fault tests and capture failures**

Run: `uv run pytest tests/integration/test_node_runtime_m5_parity.py -q && node --import tsx --test packages/runtime/test/m5-fault-injection.test.ts packages/storage/test/recovery.test.ts`

Expected: FAIL until all adapters normalize the shared corpus and failpoints.

- [ ] **Step 5: Implement parity helpers and close recovery gaps**

The TypeScript helper reads commands as JSONL and emits only normalized structural fields. The
Python helper uses production serializers/stores, never duplicate test-only schema logic. Fix any
differences in the owning package; do not weaken fixtures or add language-specific exceptions.

- [ ] **Step 6: Run the full M5 parity and recovery matrix**

Run: `uv run pytest tests/integration/test_node_runtime_m5_parity.py -q && npm run test --workspace @mycli/storage && npm run test --workspace @mycli/runtime`

Expected: all four directions and every crash boundary pass.

- [ ] **Step 7: Commit parity and crash recovery**

```bash
git add tests/fixtures/node_runtime_m5 tests/integration packages/storage/test packages/runtime/test
git commit -m "test(node-runtime): verify M5 recovery parity"
```

### Task 12: M5 Integration, Smoke, Rollout, And Full Gate

**Files:**
- Create: `apps/mycli/test/m5-state-recovery.integration.test.ts`
- Create: `scripts/smoke_node_m5_state.mjs`
- Modify: `package.json`
- Modify: `apps/mycli/package.json`
- Modify: `tests/unit/cli/node_tui/test_package_scripts.py`
- Modify: `docs/node-runtime-rollout.md`
- Modify: `.github/workflows/cross-platform.yml`

- [ ] **Step 1: Write failing complete M5 integration tests**

Add deterministic Responses and Chat scenarios:

```ts
test("Responses compacts, injects memory, resumes, and completes without Python", async (t) => {
	const fixture = await m5Fixture(t, { protocol: "responses", compactionLimit: 80 });
	await fixture.seedMemory("tone.md", "Prefer concise output.");
	await fixture.runTurn("continue this session");
	await fixture.restart();
	await fixture.resume();
	assert.equal(fixture.pythonStarted, false);
	assert.equal(fixture.persisted.compactCheckpoint, true);
	assert.equal(fixture.persisted.completedTurns, 1);
});
```

Also test queue/steer restart, strict write approval restart/approve, ambiguous claimed effect,
atomic cross-session resume, corrupt state fail-closed, Chat canonical replay, and packed executable
startup.

- [ ] **Step 2: Run integration tests and verify missing script/gate failures**

Run: `node --import tsx --test apps/mycli/test/m5-state-recovery.integration.test.ts`

Expected: FAIL until final event/state projections and package scripts exist.

- [ ] **Step 3: Add M5 package scripts and CI matrix**

```json
{
  "scripts": {
    "test:m5": "npm run build && node --import tsx --test apps/mycli/test/m5-state-recovery.integration.test.ts && uv run pytest tests/integration/test_node_runtime_m5_parity.py -q",
    "smoke:m5": "node scripts/smoke_node_m5_state.mjs --protocol responses"
  }
}
```

Update script allowlist tests and run deterministic M5 plus packed CLI smoke on Node 22.19/current
for macOS, Linux, and Windows.

- [ ] **Step 4: Implement the sanitized opt-in live smoke**

Use a disposable home/workspace/database/session, one bounded memory topic, forced small compaction
or a prebuilt compatible replay, zero retries, a short deadline, and bounded output. Print only:

```json
{"protocol":"responses","status":"completed","compacted":true,"memory_visible":true,"resumed":true,"persisted":true,"python_started":false}
```

Exit 77 when credentials/service are unavailable. Never print endpoint data, credentials, prompt,
memory, summary, provider text, raw response, tool arguments, or paths. Do not repeat an unavailable
request in the same verification run.

- [ ] **Step 5: Update rollout and rollback documentation**

Document supported M5 scope, explicit `--runtime-backend=node`, Python default, session/queue/
approval/compaction/memory behavior, stable limitations, operator rollback before a later turn,
pending-approval backend ownership, `npm run test:m5`, and live smoke sanitization.

- [ ] **Step 6: Run targeted M5 and regression gates**

Run: `npm run test:m5 && npm run test:m4 && npm run smoke:package`

Expected: M5 integration/parity, M4 regression, and packed CLI smoke pass.

- [ ] **Step 7: Run the full offline quality gate**

Run: `npm run lint && npm run typecheck && npm run contracts:check && npm run build && npm test && uv run pytest tests/unit tests/integration -q`

Expected: all commands exit 0. Record exact counts in the implementation handoff.

- [ ] **Step 8: Run sensitive-pattern and worktree checks**

Run: `git diff --check && git status --short && rg -n "sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=]" docs packages apps scripts tests -g '!*.lock'`

Expected: no whitespace errors, no credential-like additions, and only intended M5/Trellis paths
are present.

- [ ] **Step 9: Run at most one authorized live smoke when the protected service is usable**

Run: `node scripts/smoke_node_m5_state.mjs --protocol responses`

Expected: sanitized structural JSON and exit 0, or one sanitized unavailable result/exit 77. Do not
retry an unavailable paid-service request.

- [ ] **Step 10: Commit M5 integration and rollout**

```bash
git add apps/mycli/test/m5-state-recovery.integration.test.ts scripts/smoke_node_m5_state.mjs package.json apps/mycli/package.json tests/unit/cli/node_tui/test_package_scripts.py docs/node-runtime-rollout.md .github/workflows/cross-platform.yml
git commit -m "feat(node-runtime): complete M5 state recovery"
```

## Final Verification

- [ ] Run `npm run test:m5`.
- [ ] Run `npm run test:m4`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run contracts:check`.
- [ ] Run `npm run build`.
- [ ] Run `npm test`.
- [ ] Run `uv run pytest tests/unit tests/integration -q`.
- [ ] Run `npm run smoke:package`.
- [ ] Confirm the four-way persistence and every fault-injection boundary pass.
- [ ] Confirm Responses and Chat M5 integration report `python_started=false`.
- [ ] Confirm Node remains an explicit preview and Python remains the default.
- [ ] Confirm no secret, endpoint, prompt, memory body, summary, provider text, or raw response was printed or committed.

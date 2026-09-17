import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { manifestTimelineLogicalInputSha256, modelInputSha256, parseProviderNativeTransportSnapshot, providerNativeEndpointSha256, providerTimelinePrefixSha256 } from "@mycli/core";
import type { ProviderInputTimelineEvent, ProviderNativeTransportSnapshot, ProviderRequest, ProviderRequestManifestV3 } from "@mycli/core";
import type { ProviderAttemptUpdate } from "@mycli/contracts";
import { createErrorContext, providerAttemptId } from "@mycli/contracts";
import { openRuntimeSessionStore, SQLiteTranscriptEventRepository, SCHEMA_V12_VERSION, SCHEMA_V13_VERSION, StorageFailure } from "../../src/index.ts";
import type { AppendProviderAttemptInput, CommitProviderStepInput, ProviderAttemptLedgerFailpoint } from "../../src/index.ts";

const NOW = "2026-09-07T00:00:00.000Z";
const LATER = "2026-09-07T00:00:01.000Z";
const FAILURE = { code: "connection_error" as const, message: "provider connection failed", retryable: true,
	additionalDetails: "remote closed token=private-value", diagnostics: { status: 503, raw_body: "private" } };

test("enriched provider attempts retain occurrence identity across reopening without rewriting runtime state", async (t) => {
	const f = await fixture(t, { version: 14 });
	const context = createErrorContext({ reason: "transport.timed_out", source: "provider",
		scope: { kind: "provider_attempt", id: providerAttemptId("request-1", 1) }, outcome: { state: "failed", effects: "none" },
	});
	f.store.providerAttemptLedger.append(input());
	const failure = { ...FAILURE, errorContext: context, retryable: false };
	const committed = f.store.providerAttemptLedger.append(input({ sequence: 2, state: "failed", failure }));
	f.store.close();
	const reopened = openRuntimeSessionStore({ dbPath: f.dbPath, clock: () => LATER, reconcileRuntimeState: false });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.providerAttemptLedger.latest("request-1"), committed);
	assert.deepEqual(reopened.providerAttemptLedger.latest("request-1")?.failure?.errorContext, context);
	assert.equal(JSON.stringify(reopened.loadConversation("session-1")).includes(context.id), false);
});

test("attempt ledger survives reopen without entering model context or changing step lifecycle", async (t) => {
	const f = await fixture(t);
	const before = f.store.modelInputLedger.reconstructProviderStep("request-1");
	const started = f.store.providerAttemptLedger.append(input());
	f.store.providerAttemptLedger.append(input({ sequence: 2, state: "failed", failure: FAILURE }));
	f.store.providerAttemptLedger.append(input({ sequence: 3, attempt: 2, state: "scheduled", requestRetriesUsed: 1,
		failure: FAILURE, recoveryKind: "request", retryAt: LATER, resetOutput: false }));
	f.store.providerAttemptLedger.append(input({ sequence: 4, attempt: 2, state: "started", requestRetriesUsed: 1 }));
	const recovered = f.store.providerAttemptLedger.append(input({ sequence: 5, attempt: 2, state: "recovered", requestRetriesUsed: 1 }));
	assert.equal(started.retryChainId, "request-1");
	assert.notEqual(started.attemptId, recovered.attemptId);
	f.store.close();
	const reopened = openRuntimeSessionStore({ dbPath: f.dbPath, clock: () => LATER, reconcileRuntimeState: false });
	t.after(() => reopened.close());
	assert.equal(reopened.providerAttemptLedger.latest("request-1")?.state, "recovered");
	const events = reopened.providerAttemptLedger.list({ sessionId: "session-1", requestId: "request-1" });
	assert.deepEqual(events.map((event) => event.state), ["started", "failed", "scheduled", "started", "recovered"]);
	assert.equal(JSON.stringify(events).includes("private-value"), false);
	assert.equal(JSON.stringify(events).includes("raw_body"), false);
	assert.deepEqual(reopened.modelInputLedger.reconstructProviderStep("request-1"), before);
	assert.deepEqual(reopened.loadConversation("session-1"), [{ role: "user", content: "hello" }]);
	assert.deepEqual(reopened.modelInputLedger.loadProviderStepEvents("request-1").map((event) => event.state), ["prepared"]);
});

test("equal duplicates return the committed record and conflicts cannot change policy, ordering or ownership", async (t) => {
	const f = await fixture(t);
	const first = f.store.providerAttemptLedger.append(input());
	assert.deepEqual(f.store.providerAttemptLedger.append(input()), first);
	for (const candidate of [
		input({ observedAt: LATER }), input({ sequence: 3, state: "failed", failure: FAILURE }),
		input({ sequence: 2, state: "failed", failure: FAILURE, policy: { requestMaxRetries: 2, streamMaxRetries: 1 } }),
		{ ...input({ sequence: 2, state: "failed", failure: FAILURE }), turnId: "wrong" },
		{ ...input({ sequence: 2, state: "failed", failure: FAILURE }), model: "wrong" },
	]) assert.throws(() => f.store.providerAttemptLedger.append(candidate), StorageFailure);
	const other = new SQLiteTranscriptEventRepository({ dbPath: f.dbPath, ownerId: "other-owner", reconcileRuntimeState: false });
	t.after(() => other.close());
	assert.throws(() => other.providerAttemptLedger.append(input({ sequence: 2, state: "failed", failure: FAILURE })), StorageFailure);
	assert.equal(f.store.providerAttemptLedger.list({ sessionId: "session-1" }).length, 1);
});

test("scheduling reserves exactly one budget and cancellation preserves the reservation", async (t) => {
	const f = await fixture(t);
	f.store.providerAttemptLedger.append(input());
	f.store.providerAttemptLedger.append(input({ sequence: 2, state: "failed", failure: FAILURE }));
	assert.throws(() => f.store.providerAttemptLedger.append(input({
		sequence: 3, state: "scheduled", attempt: 3, requestRetriesUsed: 1, streamRetriesUsed: 1,
		failure: FAILURE, recoveryKind: "request", retryAt: LATER,
	})), StorageFailure);
	f.store.providerAttemptLedger.append(input({ sequence: 3, state: "scheduled", attempt: 2,
		requestRetriesUsed: 1, failure: FAILURE, recoveryKind: "request", retryAt: LATER }));
	const records = f.store.providerAttemptLedger.closeInterruptedTurn({ sessionId: "session-1", turnId: "turn-1", observedAt: LATER });
	assert.equal(records[0]?.state, "cancelled");
	assert.equal(records[0]?.requestRetriesUsed, 1);
	assert.deepEqual(f.store.providerAttemptLedger.closeInterruptedTurn({ sessionId: "session-1", turnId: "turn-1", observedAt: LATER }), []);
	assert.throws(() => f.store.providerAttemptLedger.append(input({ sequence: 5, state: "started", attempt: 2, requestRetriesUsed: 1 })), StorageFailure);
});

test("session lease transfer authorizes resumed turns and fences their previous owner", async (t) => {
	const f = await fixture(t);
	f.store.acquireSessionLease("session-1");
	f.store.providerAttemptLedger.append(input());
	const next = new SQLiteTranscriptEventRepository({ dbPath: f.dbPath, ownerId: "resumed-owner",
		reconcileRuntimeState: false, isProcessAlive: () => false, clock: () => LATER });
	t.after(() => next.close());
	next.acquireSessionLease("session-1");
	const failed = input({ sequence: 2, state: "failed", failure: FAILURE });
	assert.throws(() => f.store.providerAttemptLedger.append(failed), StorageFailure);
	assert.equal(next.providerAttemptLedger.append(failed).state, "failed");
	f.store.close();
	assert.equal(next.providerAttemptLedger.append(input({ sequence: 3, attempt: 2, state: "scheduled", requestRetriesUsed: 1,
		failure: FAILURE, recoveryKind: "request", retryAt: LATER, resetOutput: false })).state, "scheduled");
	next.releaseSessionLease("session-1");
	assert.throws(() => next.providerAttemptLedger.append(input({ sequence: 4, attempt: 2, state: "started", requestRetriesUsed: 1 })), StorageFailure);
});

test("restart and explicit turn interruption close started attempts as unknown atomically", async (t) => {
	const f = await fixture(t);
	f.store.providerAttemptLedger.append(input());
	f.store.close();
	const reopened = openRuntimeSessionStore({ dbPath: f.dbPath, clock: () => LATER, isProcessAlive: () => false });
	t.after(() => reopened.close());
	assert.equal(reopened.loadTurn("session-1", "client-1")?.status, "interrupted");
	assert.equal(reopened.providerAttemptLedger.latest("request-1")?.state, "unknown");
	assert.equal(reopened.providerAttemptLedger.latest("request-1")?.failure, undefined);
});

test("ledger fault points roll back chain and event without granting a start", async (t) => {
	for (const point of ["after_chain", "after_event"] as const) {
		let enabled = true;
		const f = await fixture(t, { failpoint: (name) => { if (enabled && name === point) throw new Error("private failure"); } });
		assert.throws(() => f.store.providerAttemptLedger.append(input()), StorageFailure);
		assert.equal(f.store.providerAttemptLedger.latest("request-1"), undefined);
		const database = new Database(f.dbPath, { readonly: true });
		assert.equal(database.prepare("SELECT COUNT(*) FROM provider_retry_chains").pluck().get(), 0);
		database.close();
		enabled = false;
		assert.equal(f.store.providerAttemptLedger.append(input()).sequence, 1);
	}
});

test("turn interruption and its unknown attempt roll back together on terminalization failure", async (t) => {
	let fail = true;
	const f = await fixture(t, { terminalizationFailpoint: (name) => {
		if (fail && name === "failure_after_outbox") throw new Error("test terminalization failure");
	} });
	f.store.providerAttemptLedger.append(input());
	assert.throws(() => f.store.recoverInterruptedTurn("session-1", "turn-1"), StorageFailure);
	assert.equal(f.store.loadTurn("session-1", "client-1")?.status, "in_progress");
	assert.equal(f.store.providerAttemptLedger.latest("request-1")?.state, "started");
	fail = false;
	f.store.recoverInterruptedTurn("session-1", "turn-1");
	assert.equal(f.store.loadTurn("session-1", "client-1")?.status, "interrupted");
	assert.equal(f.store.providerAttemptLedger.latest("request-1")?.state, "unknown");
});

test("v12 migration preserves canonical rows before enabling the current runtime format", async (t) => {
	const f = await fixture(t, { version: SCHEMA_V12_VERSION });
	const request = f.store.modelInputLedger.reconstructProviderStep("request-1");
	f.store.close();
	const before = new Database(f.dbPath);
	const saved = before.prepare("SELECT * FROM provider_request_manifests").all();
	before.exec("CREATE TRIGGER reject_version_update BEFORE UPDATE ON schema_version BEGIN SELECT RAISE(ABORT, 'blocked'); END");
	before.close();
	assert.throws(() => openRuntimeSessionStore({ dbPath: f.dbPath }), StorageFailure);
	const failed = new Database(f.dbPath);
	assert.equal(failed.prepare("SELECT version FROM schema_version").pluck().get(), 12);
	assert.equal(failed.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'provider_retry_chains'").pluck().get(), 0);
	failed.exec("DROP TRIGGER reject_version_update");
	failed.close();
	const migrated = openRuntimeSessionStore({ dbPath: f.dbPath, reconcileRuntimeState: false });
	t.after(() => migrated.close());
	assert.deepEqual(migrated.modelInputLedger.reconstructProviderStep("request-1"), request);
	assert.deepEqual(migrated.providerAttemptLedger.list({ sessionId: "session-1" }), []);
	const after = new Database(f.dbPath);
	assert.deepEqual(after.prepare("SELECT * FROM provider_request_manifests").all(), saved);
	assert.equal(after.prepare("SELECT version FROM schema_version").pluck().get(), 15);
	after.exec("CREATE TRIGGER reject_current_version_update BEFORE UPDATE ON schema_version BEGIN SELECT RAISE(ABORT, 'blocked'); END");
	after.close();
	migrated.close();
	openRuntimeSessionStore({ dbPath: f.dbPath, reconcileRuntimeState: false }).close();
});

test("append-only tables reject update/delete and history reads are bounded", async (t) => {
	const f = await fixture(t);
	f.store.providerAttemptLedger.append(input());
	f.store.providerAttemptLedger.append(input({ sequence: 2, state: "completed" }));
	assert.equal(f.store.providerAttemptLedger.list({ sessionId: "session-1", limit: 1 })[0]?.sequence, 2);
	assert.equal(f.store.providerAttemptLedger.list({ sessionId: "session-1", requestId: "request-1", afterSequence: 1 })[0]?.sequence, 2);
	assert.throws(() => f.store.providerAttemptLedger.list({ sessionId: "session-1", afterSequence: 1 }), StorageFailure);
	assert.throws(() => f.store.providerAttemptLedger.list({ sessionId: "session-1", limit: 1001 }), StorageFailure);
	const database = new Database(f.dbPath);
	for (const table of ["provider_retry_chains", "provider_attempt_events"]) {
		assert.throws(() => database.exec(`DELETE FROM ${table}`));
		assert.throws(() => database.exec(`UPDATE ${table} SET request_id = 'changed'`));
	}
	database.close();
});

test("native transport identity participates in durable request reconstruction and rejects drift", async (t) => {
	const nativeTransport = parseProviderNativeTransportSnapshot({ version: 1, catalogProviderId: "openai",
		api: "openai-responses", modelId: "gpt-test", endpointSha256: providerNativeEndpointSha256("https://offline.invalid/v1") });
	const f = await fixture(t, { nativeTransport });
	const expected = f.store.modelInputLedger.reconstructProviderStep("request-1");
	assert.deepEqual(expected.request.nativeTransport, nativeTransport);
	assert.deepEqual(expected.manifest.providerConfig.nativeTransport, nativeTransport);
	const altered = providerStep({ ...nativeTransport, endpointSha256: "a".repeat(64) });
	assert.throws(() => f.store.modelInputLedger.commitProviderStep(altered), StorageFailure);
	f.store.close();
	const reopened = openRuntimeSessionStore({ dbPath: f.dbPath, reconcileRuntimeState: false });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.modelInputLedger.reconstructProviderStep("request-1"), expected);
});

test("session history cursors traverse more than 200 durable attempt events and fence cursor ownership", async (t) => {
	const f = await fixture(t);
	const policy = { requestMaxRetries: 100, streamMaxRetries: 0 };
	let sequence = 1;
	f.store.providerAttemptLedger.append(input({ policy }));
	for (let retry = 1; retry <= 70; retry += 1) {
		f.store.providerAttemptLedger.append(input({ policy, sequence: ++sequence, attempt: retry,
			state: "failed", failure: FAILURE, requestRetriesUsed: retry - 1 }));
		f.store.providerAttemptLedger.append(input({ policy, sequence: ++sequence, attempt: retry + 1,
			state: "scheduled", failure: FAILURE, requestRetriesUsed: retry, recoveryKind: "request", retryAt: LATER }));
		f.store.providerAttemptLedger.append(input({ policy, sequence: ++sequence, attempt: retry + 1,
			state: "started", requestRetriesUsed: retry }));
	}
	f.store.providerAttemptLedger.append(input({ policy, sequence: ++sequence, attempt: 71,
		state: "recovered", requestRetriesUsed: 70 }));
	f.store.close();
	const reopened = openRuntimeSessionStore({ dbPath: f.dbPath, clock: () => LATER, reconcileRuntimeState: false });
	t.after(() => reopened.close());
	const newest = reopened.providerAttemptLedger.list({ sessionId: "session-1", limit: 200 });
	assert.equal(newest.length, 200);
	assert.equal(newest.at(-1)?.state, "recovered");
	const cursor = newest[0]!.eventId;
	const older = reopened.providerAttemptLedger.list({ sessionId: "session-1", beforeEventId: cursor, limit: 200 });
	assert.equal(older.length, sequence - 200);
	assert.equal(older[1]?.state, "failed");
	assert.deepEqual([...older, ...newest].map((record) => record.sequence), Array.from({ length: sequence }, (_, i) => i + 1));
	for (const invalidQuery of [
		{ sessionId: "other", beforeEventId: cursor },
		{ sessionId: "session-1", turnId: "other", beforeEventId: cursor },
		{ sessionId: "session-1", beforeEventId: "missing" },
		{ sessionId: "session-1", requestId: "request-1", beforeEventId: cursor },
	]) assert.throws(() => reopened.providerAttemptLedger.list(invalidQuery), StorageFailure);
});

function input(patch: Partial<ProviderAttemptUpdate> = {}): AppendProviderAttemptInput {
	return {
		sessionId: "session-1", turnId: "turn-1", requestId: "request-1", provider: "openai", model: "gpt-test", source: "worker",
		update: { sequence: 1, attempt: 1, state: "started", policy: { requestMaxRetries: 1, streamMaxRetries: 1 },
			requestRetriesUsed: 0, streamRetriesUsed: 0, observedAt: NOW, ...patch },
	};
}

async function fixture(t: test.TestContext, options: {
	readonly version?: typeof SCHEMA_V12_VERSION | typeof SCHEMA_V13_VERSION | 14;
	readonly failpoint?: (name: ProviderAttemptLedgerFailpoint) => void;
	readonly terminalizationFailpoint?: (name: string) => void;
	readonly nativeTransport?: ProviderNativeTransportSnapshot;
} = {}): Promise<{ readonly store: SQLiteTranscriptEventRepository; readonly dbPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-provider-attempts-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	const store = new SQLiteTranscriptEventRepository({ dbPath, clock: () => NOW, ownerId: "owner-1",
		initializeSchemaVersion: options.version ?? SCHEMA_V13_VERSION, reconcileRuntimeState: false,
		...(options.failpoint ? { providerAttemptFailpoint: options.failpoint } : {}),
		...(options.terminalizationFailpoint ? { turnTerminalizationFailpoint: options.terminalizationFailpoint } : {}),
	});
	t.after(() => store.close());
	store.reserveTurn({ sessionId: "session-1", turnId: "turn-1", clientTurnId: "client-1", clientUserMessageId: "user-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`, workspaceRoot: root, threadId: "session-1", userText: "hello", startedAt: NOW });
	store.modelInputLedger.commitProviderStep(providerStep(options.nativeTransport));
	return { store, dbPath };
}

function providerStep(nativeTransport?: ProviderNativeTransportSnapshot): CommitProviderStepInput {
	const instructionSnapshot = { snapshotId: "instructions-1", version: "v1", source: "builtin", content: "You are mycli.",
		contentSha256: modelInputSha256("You are mycli."), createdAt: NOW };
	const toolSetSnapshot = { snapshotId: "tools-1", tools: [], contentSha256: modelInputSha256([]), createdAt: NOW };
	const user = { type: "user" as const, text: "hello" };
	const timelineEvents: readonly ProviderInputTimelineEvent[] = [{
		eventId: "boundary-1", sessionId: "session-1", windowId: "window-1", turnId: "turn-1", providerStep: 1,
		kind: "window_boundary", boundary: "bootstrap", contentSha256: modelInputSha256({ window_id: "window-1", boundary: "bootstrap" }), createdAt: NOW,
	}, {
		eventId: "timeline-user-1", sessionId: "session-1", windowId: "window-1", turnId: "turn-1", providerStep: 1,
		kind: "conversation_item", item: user, sourceIndex: 0, contentSha256: modelInputSha256(user), createdAt: NOW,
	}];
	const providerConfig = { provider: "openai" as const, protocol: "responses" as const, model: "gpt-test", sessionId: "session-1", cacheRetention: "short" as const,
		...(nativeTransport ? { nativeTransport } : {}) };
	const request: ProviderRequest = { ...providerConfig, instructions: instructionSnapshot.content,
		messages: [{ role: "user", content: "hello" }], items: [user], tools: [] };
	const bootstrapPrefixSha256 = modelInputSha256({ instruction_snapshot_sha256: instructionSnapshot.contentSha256,
		tool_set_snapshot_sha256: toolSetSnapshot.contentSha256, items: [] });
	const timelineSha256 = modelInputSha256(request.items);
	const manifest: ProviderRequestManifestV3 = {
		schemaVersion: 3, requestId: "request-1", sessionId: "session-1", turnId: "turn-1", providerStep: 1, providerConfig,
		instructionSnapshotId: instructionSnapshot.snapshotId, toolSetSnapshotId: toolSetSnapshot.snapshotId,
		requestSignature: "sha256:request-signature", logicalInputSha256: manifestTimelineLogicalInputSha256(instructionSnapshot, toolSetSnapshot, timelineSha256),
		contextPrefixSha256: bootstrapPrefixSha256, boundary: "bootstrap", createdAt: NOW, timelineWindowId: "window-1",
		timelineEventCount: timelineEvents.length, timelinePrefixSha256: providerTimelinePrefixSha256(timelineEvents),
		requestConfigurationSha256: modelInputSha256({ provider_config: providerConfig,
			instruction_snapshot_sha256: instructionSnapshot.contentSha256, tool_set_snapshot_sha256: toolSetSnapshot.contentSha256 }),
		bootstrapPrefixSha256, timelineSha256, commonPrefixItemCount: 0,
	};
	return { instructionSnapshot, toolSetSnapshot, contextEvents: [], timelineEvents, manifest, request,
		preparedEvent: { eventId: "prepared-1", requestId: "request-1", sessionId: "session-1", state: "prepared", payload: {}, createdAt: NOW } };
}

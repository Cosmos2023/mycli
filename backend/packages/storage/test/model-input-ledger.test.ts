import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	effectiveModelContextEvents,
	manifestLogicalInputSha256,
	modelInputSha256,
} from "@mycli/core";
import type {
	InstructionFragment,
	InstructionSnapshot,
	ModelContextEvent,
	ModelInputReference,
	ProviderInputTimelineEvent,
	ProviderRequest,
	ProviderRequestManifest,
	ToolDefinition,
	ToolSetSnapshot,
} from "@mycli/core";
import {
	SQLiteSessionStore,
	StorageFailure,
} from "../src/index.ts";
import type {
	CommitProviderStepInput,
	ProviderStepLifecycleEvent,
} from "../src/index.ts";

const NOW = "2026-08-08T00:00:00.000Z";
const LATER = "2026-08-08T00:00:01.000Z";

test("atomically commits and reconstructs an exact bootstrap provider request", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	t.after(() => store.close());
	reserveSession(store, fixture.root);
	const input = providerStep();

	assert.equal(store.modelInputLedger.requiresBootstrap("session-1"), true);
	const committed = store.modelInputLedger.commitProviderStep(input);
	assert.deepEqual(committed, { manifest: input.manifest, request: input.request });
	assert.equal(store.modelInputLedger.requiresBootstrap("session-1"), false);
	assert.deepEqual(store.modelInputLedger.commitProviderStep(input), committed);
	assert.deepEqual(store.modelInputLedger.reconstructProviderStep("request-1"), committed);
	assert.deepEqual(store.modelInputLedger.loadLatestInstructionSnapshot("session-1"), input.instructionSnapshot);
	assert.deepEqual(store.modelInputLedger.loadLatestToolSetSnapshot("session-1"), input.toolSetSnapshot);
	assert.deepEqual(store.modelInputLedger.loadModelContextEvents("session-1"), input.contextEvents);
	assert.deepEqual(store.modelInputLedger.loadProviderStepEvents("request-1"), [input.preparedEvent]);

	store.close();
	const reopened = sessionStore(fixture.dbPath);
	t.after(() => reopened.close());
	assert.deepEqual(reopened.modelInputLedger.reconstructProviderStep("request-1"), committed);
	const database = new Database(fixture.dbPath, { readonly: true });
	t.after(() => database.close());
	assert.equal(count(database, "instruction_snapshots"), 1);
	assert.equal(count(database, "tool_set_snapshots"), 1);
	assert.equal(count(database, "model_context_events"), 1);
	assert.equal(count(database, "provider_request_manifests"), 1);
	assert.equal(count(database, "provider_step_events"), 1);
});

test("persists and reconstructs an immutable v2 provider input timeline", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	reserveSession(store, fixture.root);
	const input = timelineProviderStep();

	const committed = store.modelInputLedger.commitProviderStep(input);
	assert.deepEqual(committed, { manifest: input.manifest, request: input.request });
	assert.deepEqual(
		store.modelInputLedger.loadProviderInputTimelineEvents("session-1"),
		input.timelineEvents,
	);
	assert.deepEqual(store.modelInputLedger.reconstructProviderStep("request-timeline"), committed);
	store.close();

	const database = new Database(fixture.dbPath);
	assert.equal(count(database, "provider_input_timeline_events"), 3);
	assert.throws(
		() => database.prepare("UPDATE provider_input_timeline_events SET kind = kind").run(),
		/immutable/u,
	);
	assert.throws(
		() => database.prepare("DELETE FROM provider_input_timeline_events").run(),
		/append-only/u,
	);
	database.close();
});

test("rolls back timeline events with the complete provider step", async (t) => {
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({
		dbPath: fixture.dbPath,
		clock: () => NOW,
		modelInputFailpoint: (name) => {
			if (name === "after_timeline_events") throw new Error("injected timeline failure");
		},
	});
	reserveSession(store, fixture.root);
	assert.throws(
		() => store.modelInputLedger.commitProviderStep(timelineProviderStep()),
		StorageFailure,
	);
	store.close();

	const database = new Database(fixture.dbPath, { readonly: true });
	for (const table of [
		"model_context_events",
		"provider_input_timeline_events",
		"provider_request_manifests",
		"provider_step_events",
	]) {
		assert.equal(count(database, table), 0, `${table} was not rolled back`);
	}
	database.close();
});

test("appends complete superseding context and tombstones without rewriting history", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	t.after(() => store.close());
	reserveSession(store, fixture.root);
	const first = providerStep();
	store.modelInputLedger.commitProviderStep(first);
	const firstEvent = first.contextEvents[0] as ModelContextEvent;
	const replacement = contextEvent({
		eventId: "context-2",
		providerStep: 1,
		content: "Use repository rules version two.",
		supersedesEventId: firstEvent.eventId,
		createdAt: LATER,
	});
	const second = providerStep({
		requestId: "request-2",
		providerStep: 1,
		previousManifestId: "request-1",
		contextEvents: [replacement],
		createdAt: LATER,
	});
	store.modelInputLedger.commitProviderStep(second);
	const tombstone = contextEvent({
		eventId: "context-3",
		providerStep: 2,
		supersedesEventId: replacement.eventId,
		tombstone: true,
		createdAt: "2026-08-08T00:00:02.000Z",
	});
	const third = providerStep({
		requestId: "request-3",
		providerStep: 2,
		previousManifestId: "request-2",
		contextEvents: [tombstone],
		createdAt: "2026-08-08T00:00:02.000Z",
	});
	store.modelInputLedger.commitProviderStep(third);

	const events = store.modelInputLedger.loadModelContextEvents("session-1");
	assert.deepEqual(events, [firstEvent, replacement, tombstone]);
	assert.equal(effectiveModelContextEvents(events).has("workspace"), false);
	assert.deepEqual(store.modelInputLedger.loadProviderRequestManifest("request-1"), first.manifest);
	assert.deepEqual(store.modelInputLedger.loadProviderRequestManifest("request-2"), second.manifest);
	assert.deepEqual(store.modelInputLedger.loadProviderRequestManifest("request-3"), third.manifest);
});

test("rolls back every model-input record when a provider-step transaction fails", async (t) => {
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({
		dbPath: fixture.dbPath,
		clock: () => NOW,
		modelInputFailpoint: (name) => {
			if (name === "after_request_manifest") throw new Error("injected failure");
		},
	});
	reserveSession(store, fixture.root);
	assert.throws(
		() => store.modelInputLedger.commitProviderStep(providerStep()),
		StorageFailure,
	);
	assert.equal(store.modelInputLedger.requiresBootstrap("session-1"), true);
	store.close();

	const database = new Database(fixture.dbPath, { readonly: true });
	for (const table of [
		"model_input_blobs",
		"instruction_snapshots",
		"tool_set_snapshots",
		"model_context_events",
		"provider_request_manifests",
		"provider_step_events",
	]) {
		assert.equal(count(database, table), 0, `${table} was not rolled back`);
	}
	database.close();

	const reopened = sessionStore(fixture.dbPath);
	t.after(() => reopened.close());
	assert.deepEqual(
		reopened.modelInputLedger.commitProviderStep(providerStep()).request,
		providerStep().request,
	);
});

test("rejects snapshot, request, and blob identifier collisions", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	reserveSession(store, fixture.root);
	const input = providerStep();
	store.modelInputLedger.commitProviderStep(input);
	const changedInstructions = instructionSnapshot("Different instructions.");
	const changedOrderedItems = input.manifest.orderedItems.map((reference) => (
		reference.kind === "instruction_snapshot"
			? { ...reference, contentSha256: changedInstructions.contentSha256 }
			: reference
	));
	const changedManifest: ProviderRequestManifest = {
		...input.manifest,
		orderedItems: changedOrderedItems,
		logicalInputSha256: manifestLogicalInputSha256(
			changedInstructions,
			input.toolSetSnapshot,
			changedOrderedItems,
		),
	};
	assert.throws(
		() => store.modelInputLedger.commitProviderStep({
			...input,
			instructionSnapshot: changedInstructions,
			manifest: changedManifest,
			request: { ...input.request, instructions: changedInstructions.content },
		}),
		/snapshot id collides/u,
	);
	assert.equal(store.modelInputLedger.loadProviderStepEvents("request-1").length, 1);
	store.close();

	const collisionFixture = await databaseFixture(t);
	const seed = sessionStore(collisionFixture.dbPath);
	reserveSession(seed, collisionFixture.root);
	seed.close();
	const collisionInput = providerStep();
	const blobId = modelInputSha256(collisionInput.instructionSnapshot);
	const database = new Database(collisionFixture.dbPath);
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
		VALUES (?, ?, ?)
	`).run(blobId, "{}", NOW);
	database.close();
	const collisionStore = sessionStore(collisionFixture.dbPath);
	t.after(() => collisionStore.close());
	assert.throws(
		() => collisionStore.modelInputLedger.commitProviderStep(collisionInput),
		/blob hash collides/u,
	);
	assert.equal(collisionStore.modelInputLedger.requiresBootstrap("session-1"), true);
});

test("requires an append-only bootstrap boundary for a legacy session", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	reserveSession(store, fixture.root);
	assert.deepEqual(store.loadConversation("session-1"), [{
		role: "user",
		content: "Inspect the repository.",
	}]);
	const missingBoundary = providerStep({ boundary: undefined });
	assert.throws(
		() => store.modelInputLedger.commitProviderStep(missingBoundary),
		/first provider request requires a bootstrap boundary/u,
	);
	assert.equal(store.modelInputLedger.requiresBootstrap("session-1"), true);
	assert.deepEqual(store.loadConversation("session-1"), [{
		role: "user",
		content: "Inspect the repository.",
	}]);
	store.modelInputLedger.commitProviderStep(providerStep());
	assert.equal(store.modelInputLedger.requiresBootstrap("session-1"), false);
});

test("rejects unknown logical request fields without persisting a partial step", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	t.after(() => store.close());
	reserveSession(store, fixture.root);
	const input = providerStep();
	const invalidRequest = {
		...input.request,
		transportCredential: "must-not-be-persisted",
	} as ProviderRequest;
	assert.throws(
		() => store.modelInputLedger.commitProviderStep({ ...input, request: invalidRequest }),
		/logical provider request contains unknown fields/u,
	);
	assert.equal(store.modelInputLedger.requiresBootstrap("session-1"), true);
	const database = new Database(fixture.dbPath, { readonly: true });
	t.after(() => database.close());
	assert.equal(count(database, "model_input_blobs"), 0);
	assert.equal(count(database, "provider_request_manifests"), 0);
});

test("does not append new context through an idempotent manifest retry", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	t.after(() => store.close());
	reserveSession(store, fixture.root);
	const input = providerStep();
	store.modelInputLedger.commitProviderStep(input);
	const extraWorkspace = contextEvent({
		eventId: "context-extra",
		providerStep: 0,
		content: "Unexpected retry context.",
		createdAt: NOW,
	});
	const extra: ModelContextEvent = Object.freeze({
		...extraWorkspace,
		sectionKey: "hook",
		fragment: Object.freeze({
			...(extraWorkspace.fragment as InstructionFragment),
			fragmentId: "context-extra:hook",
			key: "hook",
			kind: "hook_context",
		}),
	});
	assert.throws(
		() => store.modelInputLedger.commitProviderStep({
			...input,
			contextEvents: [...input.contextEvents, extra],
		}),
		/provider step context events conflict/u,
	);
	assert.deepEqual(store.modelInputLedger.loadModelContextEvents("session-1"), input.contextEvents);
});

test("reconstructs from immutable records after mutable state is removed", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	reserveSession(store, fixture.root);
	const input = providerStep();
	store.modelInputLedger.commitProviderStep(input);
	store.close();
	const database = new Database(fixture.dbPath);
	database.prepare(`
		INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
		VALUES (?, ?, ?, ?)
	`).run("session-1", "context_baseline", "{}", NOW);
	database.prepare("DELETE FROM session_state WHERE session_id = ?").run("session-1");
	database.close();
	const reopened = sessionStore(fixture.dbPath);
	t.after(() => reopened.close());
	assert.deepEqual(reopened.modelInputLedger.reconstructProviderStep("request-1"), {
		manifest: input.manifest,
		request: input.request,
	});
});

test("enforces append-only tables and monotonic provider-step lifecycle events", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	reserveSession(store, fixture.root);
	store.modelInputLedger.commitProviderStep(providerStep());
	store.modelInputLedger.appendProviderStepEvent(lifecycleEvent(
		"dispatch-1",
		"dispatch_started",
		LATER,
	));
	store.modelInputLedger.appendProviderStepEvent(lifecycleEvent(
		"ack-1",
		"acknowledged",
		"2026-08-08T00:00:02.000Z",
	));
	assert.throws(
		() => store.modelInputLedger.appendProviderStepEvent(lifecycleEvent(
			"late-failure",
			"failed",
			"2026-08-08T00:00:03.000Z",
		)),
		/invalid provider-step lifecycle transition/u,
	);
	store.close();

	const database = new Database(fixture.dbPath);
	for (const table of [
		"model_input_blobs",
		"instruction_snapshots",
		"tool_set_snapshots",
		"model_context_events",
		"provider_request_manifests",
		"provider_step_events",
	]) {
		assert.throws(
			() => database.prepare(`UPDATE ${table} SET created_at = created_at`).run(),
			/immutable/u,
		);
		assert.throws(
			() => database.prepare(`DELETE FROM ${table}`).run(),
			/append-only/u,
		);
	}
	database.close();
});

test("recovers committed but unconfirmed requests as unknown without claiming completion", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	reserveSession(store, fixture.root);
	store.modelInputLedger.commitProviderStep(providerStep());
	store.modelInputLedger.appendProviderStepEvent(lifecycleEvent(
		"dispatch-1",
		"dispatch_started",
		LATER,
	));

	assert.deepEqual(
		store.modelInputLedger.loadUnconfirmedProviderSteps("session-1").map((step) => (
			step.latestEvent.state
		)),
		["dispatch_started"],
	);
	const recovered = store.modelInputLedger.recoverUnconfirmedProviderSteps({
		sessionId: "session-1",
		createdAt: "2026-08-08T00:00:02.000Z",
		createEventId: (requestId) => `${requestId}:recovered`,
	});
	assert.deepEqual(recovered.map((step) => step.latestEvent.state), ["unknown"]);
	assert.equal(
		store.modelInputLedger.loadProviderStepEvents("request-1").some((event) => (
			event.state === "acknowledged"
		)),
		false,
	);
	assert.deepEqual(
		store.modelInputLedger.recoverUnconfirmedProviderSteps({
			sessionId: "session-1",
			createdAt: "2026-08-08T00:00:03.000Z",
			createEventId: () => "must-not-be-used",
		}).map((step) => step.latestEvent.state),
		["unknown"],
	);
	store.close();
});

function providerStep(options: {
	readonly requestId?: string;
	readonly providerStep?: number;
	readonly previousManifestId?: string;
	readonly boundary?: ProviderRequestManifest["boundary"];
	readonly contextEvents?: readonly ModelContextEvent[];
	readonly createdAt?: string;
} = {}): CommitProviderStepInput {
	const createdAt = options.createdAt ?? NOW;
	const providerStep = options.providerStep ?? 0;
	const requestId = options.requestId ?? "request-1";
	const instructions = instructionSnapshot();
	const toolSet = toolSetSnapshot();
	const contextEvents = options.contextEvents ?? [contextEvent({
		eventId: "context-1",
		providerStep,
		createdAt,
	})];
	const contextReferences = contextEvents.flatMap((event): ModelInputReference[] => (
		event.fragment ? [{
			kind: "context_event",
			id: event.eventId,
			role: event.fragment.role,
			contentSha256: event.fragment.contentSha256,
		}] : []
	));
	const orderedItems: readonly ModelInputReference[] = [
		{
			kind: "instruction_snapshot",
			id: instructions.snapshotId,
			role: "system",
			contentSha256: instructions.contentSha256,
		},
		{
			kind: "tool_set_snapshot",
			id: toolSet.snapshotId,
			contentSha256: toolSet.contentSha256,
		},
		...contextReferences,
		{
			kind: "conversation_item",
			id: "turn-1:user",
			role: "user",
			contentSha256: modelInputSha256("Inspect the repository."),
		},
	];
	const request: ProviderRequest = {
		provider: "openai",
		protocol: "responses",
		model: "gpt-5.5",
		instructions: instructions.content,
		messages: [{ role: "user", content: "Inspect the repository." }],
		items: [{ type: "user", text: "Inspect the repository." }],
		tools: toolSet.tools,
	};
	const manifest: ProviderRequestManifest = {
		schemaVersion: 1,
		requestId,
		sessionId: "session-1",
		turnId: "turn-1",
		providerStep,
		providerConfig: {
			provider: request.provider,
			protocol: request.protocol,
			model: request.model,
		},
		instructionSnapshotId: instructions.snapshotId,
		toolSetSnapshotId: toolSet.snapshotId,
		orderedItems,
		requestSignature: "sha256:request-signature",
		logicalInputSha256: manifestLogicalInputSha256(instructions, toolSet, orderedItems),
		contextPrefixSha256: modelInputSha256(contextReferences),
		...(options.previousManifestId ? { previousManifestId: options.previousManifestId } : {}),
		...(Object.hasOwn(options, "boundary")
			? (options.boundary ? { boundary: options.boundary } : {})
			: (options.previousManifestId ? {} : { boundary: "bootstrap" })),
		createdAt,
	};
	return Object.freeze({
		instructionSnapshot: instructions,
		toolSetSnapshot: toolSet,
		contextEvents,
		manifest,
		request,
		preparedEvent: lifecycleEvent(`${requestId}:prepared`, "prepared", createdAt, requestId),
	});
}

function timelineProviderStep(): CommitProviderStepInput {
	const base = providerStep({ requestId: "request-timeline" });
	const context = base.contextEvents[0] as ModelContextEvent;
	const fragment = context.fragment as InstructionFragment;
	const contextItem = Object.freeze({
		type: "context" as const,
		text: fragment.content,
		metadata: Object.freeze({
			kind: "workspace_instructions" as const,
			role: "user" as const,
			cacheClass: "static" as const,
			durability: "persistent" as const,
			scope: "session" as const,
			sourceId: "ctx-workspace",
			contentSha256: fragment.contentSha256,
			contentLength: fragment.content.length,
		}),
	});
	const userItem = Object.freeze({ type: "user" as const, text: "Inspect the repository." });
	const windowId = "window-1-test";
	const boundary: ProviderInputTimelineEvent = Object.freeze({
		eventId: "timeline-boundary-1",
		sessionId: "session-1",
		windowId,
		turnId: "turn-1",
		providerStep: 0,
		kind: "window_boundary",
		boundary: "bootstrap",
		contentSha256: modelInputSha256({ window_id: windowId, boundary: "bootstrap" }),
		createdAt: NOW,
	});
	const contextTimeline: ProviderInputTimelineEvent = Object.freeze({
		eventId: "timeline-context-1",
		sessionId: "session-1",
		windowId,
		turnId: "turn-1",
		providerStep: 0,
		kind: "context_update",
		item: contextItem,
		modelContextEventId: context.eventId,
		contentSha256: modelInputSha256(contextItem),
		createdAt: NOW,
	});
	const userTimeline: ProviderInputTimelineEvent = Object.freeze({
		eventId: "timeline-user-1",
		sessionId: "session-1",
		windowId,
		turnId: "turn-1",
		providerStep: 0,
		kind: "conversation_item",
		item: userItem,
		sourceIndex: 0,
		contentSha256: modelInputSha256(userItem),
		createdAt: NOW,
	});
	const timelineEvents = Object.freeze([boundary, contextTimeline, userTimeline]);
	const orderedItems: readonly ModelInputReference[] = Object.freeze([
		base.manifest.orderedItems[0] as ModelInputReference,
		base.manifest.orderedItems[1] as ModelInputReference,
		...timelineEvents.flatMap((event): ModelInputReference[] => event.item ? [{
			kind: "provider_timeline_event",
			id: event.eventId,
			role: event.item.type === "context" ? event.item.metadata.role : "user",
			contentSha256: event.contentSha256,
		}] : []),
	]);
	const request: ProviderRequest = Object.freeze({
		...base.request,
		items: Object.freeze([contextItem, userItem]),
	});
	const bootstrapPrefixSha256 = modelInputSha256({
		instruction_snapshot_sha256: base.instructionSnapshot.contentSha256,
		tool_set_snapshot_sha256: base.toolSetSnapshot.contentSha256,
		items: [contextItem],
	});
	const manifest: ProviderRequestManifest = Object.freeze({
		...base.manifest,
		schemaVersion: 2,
		requestId: "request-timeline",
		orderedItems,
		logicalInputSha256: manifestLogicalInputSha256(
			base.instructionSnapshot,
			base.toolSetSnapshot,
			orderedItems,
		),
		contextPrefixSha256: bootstrapPrefixSha256,
		timelineWindowId: windowId,
		timelineEventIds: timelineEvents.map((event) => event.eventId),
		requestConfigurationSha256: modelInputSha256(base.manifest.providerConfig),
		bootstrapPrefixSha256,
		timelineSha256: modelInputSha256(request.items),
		commonPrefixItemCount: 0,
	});
	return Object.freeze({
		instructionSnapshot: base.instructionSnapshot,
		toolSetSnapshot: base.toolSetSnapshot,
		contextEvents: base.contextEvents,
		timelineEvents,
		manifest,
		request,
		preparedEvent: Object.freeze({
			...base.preparedEvent,
			eventId: "request-timeline:prepared",
			requestId: "request-timeline",
		}),
	});
}

function instructionSnapshot(content = "You are mycli."): InstructionSnapshot {
	return Object.freeze({
		snapshotId: "instructions-1",
		version: "v1",
		source: "builtin",
		content,
		contentSha256: modelInputSha256(content),
		createdAt: NOW,
	});
}

function toolSetSnapshot(): ToolSetSnapshot {
	const tools: readonly ToolDefinition[] = [Object.freeze({
		id: "Read",
		name: "Read",
		description: "Read a file.",
		inputSchema: Object.freeze({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		}),
	})];
	return Object.freeze({
		snapshotId: "tools-1",
		tools,
		contentSha256: modelInputSha256(tools),
		createdAt: NOW,
	});
}

function contextEvent(options: {
	readonly eventId: string;
	readonly providerStep: number;
	readonly content?: string;
	readonly supersedesEventId?: string;
	readonly tombstone?: boolean;
	readonly createdAt: string;
}): ModelContextEvent {
	const tombstone = options.tombstone ?? false;
	const content = options.content ?? "Use repository rules version one.";
	const fragment: InstructionFragment = Object.freeze({
		fragmentId: `${options.eventId}:fragment`,
		key: "workspace",
		kind: "workspace_instructions",
		title: "Workspace instructions",
		content,
		contentSha256: modelInputSha256(content),
		role: "user",
		source: "AGENTS.md",
		cacheClass: "static",
		durability: "persistent",
		scope: "session",
		includeInMemory: false,
		required: false,
	});
	return Object.freeze({
		eventId: options.eventId,
		sessionId: "session-1",
		turnId: "turn-1",
		providerStep: options.providerStep,
		sectionKey: "workspace",
		...(tombstone ? {} : { fragment }),
		...(options.supersedesEventId ? { supersedesEventId: options.supersedesEventId } : {}),
		tombstone,
		createdAt: options.createdAt,
	});
}

function lifecycleEvent<State extends ProviderStepLifecycleEvent["state"]>(
	eventId: string,
	state: State,
	createdAt: string,
	requestId = "request-1",
): ProviderStepLifecycleEvent & { readonly state: State } {
	return Object.freeze({
		eventId,
		requestId,
		sessionId: "session-1",
		state,
		payload: Object.freeze({}),
		createdAt,
	});
}

function reserveSession(store: SQLiteSessionStore, workspaceRoot: string): void {
	store.reserveTurn({
		sessionId: "session-1",
		clientTurnId: "client-turn-1",
		clientUserMessageId: "user-message-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot,
		threadId: "thread-1",
		userText: "Inspect the repository.",
		startedAt: NOW,
	});
}

function sessionStore(dbPath: string): SQLiteSessionStore {
	return new SQLiteSessionStore({ dbPath, clock: () => NOW });
}

function count(database: Database.Database, table: string): number {
	return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
		readonly count: unknown;
	}).count);
}

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-model-input-ledger-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}

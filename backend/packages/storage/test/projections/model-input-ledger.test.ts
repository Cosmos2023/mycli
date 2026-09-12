import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	effectiveModelContextEvents,
	manifestLogicalInputSha256,
	manifestTimelineLogicalInputSha256,
	modelInputSha256,
	parseProviderRouteId,
	projectProviderRequest,
	providerTimelinePrefixSha256,
	toolDiscovery,
} from "@mycli/core";
import type {
	InstructionFragment,
	InstructionSnapshot,
	CanonicalConversationItem,
	ModelContextEvent,
	ModelInputReference,
	ProviderInputTimelineEvent,
	ProviderRequest,
	ProviderRequestManifest,
	ProviderRequestManifestV1,
	ProviderRequestManifestV2,
	ProviderRequestManifestV3,
	ToolDefinition,
	ToolSetSnapshot,
} from "@mycli/core";
import {
	MODEL_INPUT_CONTENT_BLOB_MARKER_JSON,
	SCHEMA_V10_VERSION,
	SCHEMA_V11_VERSION,
	SCHEMA_V12_VERSION,
	SQLiteSessionStore,
	SQLiteTranscriptEventRepository,
	StorageFailure,
	encodeSessionContentBlob,
} from "../../src/index.ts";
import {
	modelInputBlob,
	normalizeProviderInputTimelineEvent,
	normalizeProviderRequest,
} from "../../src/projections/model-input-validation.ts";
import type {
	CommitProviderStepInput,
	ModelInputLedgerFailpoint,
	ProviderStepLifecycleEvent,
} from "../../src/index.ts";

const NOW = "2026-08-08T00:00:00.000Z";
const LATER = "2026-08-08T00:00:01.000Z";

type ProviderStepInputV1 = Omit<CommitProviderStepInput, "manifest"> & {
	readonly manifest: ProviderRequestManifestV1;
};

type ProviderStepInputV2 = Omit<CommitProviderStepInput, "manifest"> & {
	readonly manifest: ProviderRequestManifestV2;
};

type ProviderStepInputV3 = Omit<CommitProviderStepInput, "manifest"> & {
	readonly manifest: ProviderRequestManifestV3;
};

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

test("round trips dynamic provider routes and rejects malformed model-input identities", async (t) => {
	const fixture = await databaseFixture(t);
	const store = sessionStore(fixture.dbPath);
	t.after(() => store.close());
	reserveSession(store, fixture.root);
	const base = providerStep({ requestId: "request-dynamic-provider" });
	const malformed = {
		...base,
		manifest: {
			...base.manifest,
			providerConfig: { ...base.manifest.providerConfig, provider: "Cloudflare" },
		},
		request: { ...base.request, provider: "Cloudflare" },
	} as unknown as CommitProviderStepInput;
	assert.throws(() => store.modelInputLedger.commitProviderStep(malformed), StorageFailure);

	const provider = parseProviderRouteId("cloudflare-ai-gateway");
	const input = Object.freeze({
		...base,
		manifest: Object.freeze({
			...base.manifest,
			providerConfig: Object.freeze({ ...base.manifest.providerConfig, provider }),
		}),
		request: Object.freeze({ ...base.request, provider }),
	});
	const committed = store.modelInputLedger.commitProviderStep(input);
	assert.deepEqual(committed, { manifest: input.manifest, request: input.request });
	assert.deepEqual(
		store.modelInputLedger.reconstructProviderStep("request-dynamic-provider"),
		committed,
	);
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

test("preserves tool discovery load points in model-input requests and hashed timeline events", () => {
	const discovery = toolDiscovery({
		id: "mcp:docs:search", name: "mcp_docs_search", description: "Search docs",
		inputSchema: { type: "object" },
	});
	const item: CanonicalConversationItem = {
		type: "tool_result", callId: "search-1", toolName: "tool_search",
		output: "Found a documentation tool.", success: true, toolDiscoveries: [discovery],
	};
	const request: ProviderRequest = { ...providerStep().request, messages: [], items: [item] };
	assert.deepEqual(normalizeProviderRequest(request), request);
	const event: ProviderInputTimelineEvent = {
		eventId: "timeline-discovery", sessionId: "session-1", windowId: "window-1",
		turnId: "turn-1", providerStep: 1, kind: "conversation_item", sourceIndex: 2,
		item, contentSha256: modelInputSha256(item), createdAt: NOW,
	};
	assert.deepEqual(normalizeProviderInputTimelineEvent(event), event);
	assert.throws(() => normalizeProviderInputTimelineEvent({
		...event, item: { ...item, toolDiscoveries: [{ ...discovery, definitionSha256: "invalid" }] },
	}), StorageFailure);
	assert.throws(() => normalizeProviderInputTimelineEvent({
		...event, item: { ...item, toolDiscoveries: [] },
	}), StorageFailure);
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
	const changedManifest: ProviderRequestManifestV1 = {
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

test("stores v11 model-input ownership through compressed content without changing logical ids", async (t) => {
	const input = timelineProviderStep({
		payloadText: "large immutable model input payload\n".repeat(200),
		requestSignature: "signature-segment-".repeat(200),
		toolDescription: "large tool description\n".repeat(200),
	});
	const v10 = await transcriptLedgerFixture(t, SCHEMA_V10_VERSION, "v10");
	const v11 = await transcriptLedgerFixture(t, SCHEMA_V11_VERSION, "v11");
	const expected = { manifest: input.manifest, request: input.request };
	assert.deepEqual(v10.repository.modelInputLedger.commitProviderStep(input), expected);
	assert.deepEqual(v11.repository.modelInputLedger.commitProviderStep(input), expected);
	assert.deepEqual(v11.repository.modelInputLedger.commitProviderStep(input), expected);
	assert.deepEqual(modelInputOwnership(v11.dbPath), modelInputOwnership(v10.dbPath));

	const database = new Database(v11.dbPath, { readonly: true });
	assert.equal(count(database, "model_input_blobs"), count(database, "model_input_blob_refs"));
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM model_input_blobs WHERE payload_json != ?
	`).pluck().get(MODEL_INPUT_CONTENT_BLOB_MARKER_JSON), 0);
	const codecs = database.prepare(`
		SELECT owner.blob_id, content.codec
		FROM model_input_blobs AS owner
		JOIN model_input_blob_refs AS reference ON reference.blob_id = owner.blob_id
		JOIN session_content_blobs AS content ON content.blob_id = reference.content_blob_id
	`).all() as readonly { readonly blob_id: string; readonly codec: string }[];
	const compressedIds = new Set(codecs.filter((row) => row.codec === "deflate-raw-v1")
		.map((row) => row.blob_id));
	const ownership = modelInputOwnership(v11.dbPath);
	for (const blobId of [
		ownership.instructionBlobId,
		ownership.toolSetBlobId,
		ownership.contextBlobIds[0],
		...ownership.timelineBlobIds.slice(1),
		ownership.manifestBlobId,
		ownership.requestBlobId,
	]) assert.ok(blobId && compressedIds.has(blobId), blobId);
	database.close();
	const continued = continuedTimelineProviderStep(input);
	const continuedExpected = { manifest: continued.manifest, request: continued.request };
	assert.deepEqual(v11.repository.modelInputLedger.commitProviderStep(continued), continuedExpected);
	assert.deepEqual(
		v11.repository.modelInputLedger.reconstructProviderStep(input.manifest.requestId),
		expected,
	);

	v11.repository.close();
	const reopened = new SQLiteTranscriptEventRepository({ dbPath: v11.dbPath, clock: () => NOW });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.modelInputLedger.reconstructProviderStep(input.manifest.requestId), expected);
	assert.deepEqual(
		reopened.modelInputLedger.reconstructProviderStep(continued.manifest.requestId),
		continuedExpected,
	);
	assert.deepEqual(
		reopened.modelInputLedger.loadProviderInputTimelineEvents("session-1"),
		[...(input.timelineEvents ?? []), ...(continued.timelineEvents ?? [])],
	);
});

test("reconstructs legacy cache fields from a v10 request blob", async (t) => {
	const fixture = await transcriptLedgerFixture(t, SCHEMA_V10_VERSION, "v10-legacy-cache");
	const input = timelineProviderStep();
	fixture.repository.modelInputLedger.commitProviderStep(input);
	fixture.repository.close();
	rewriteCacheVocabularyAsLegacy(fixture.dbPath, input, false);

	const reopened = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath, clock: () => NOW });
	t.after(() => reopened.close());
	const reconstructed = reopened.modelInputLedger.reconstructProviderStep(input.manifest.requestId);
	assert.deepEqual(reconstructed.request, input.request);
	assert.deepEqual(reconstructed.manifest.providerConfig, input.manifest.providerConfig);
});

test("rolls back v11 model-input content and references with the provider step", async (t) => {
	const fixture = await transcriptLedgerFixture(t, SCHEMA_V11_VERSION, "rollback", {
		modelInputFailpoint: (name) => {
			if (name === "after_request_manifest") throw new Error("injected provider commit failure");
		},
	});
	assert.throws(
		() => fixture.repository.modelInputLedger.commitProviderStep(timelineProviderStep({
			payloadText: "rollback model input payload\n".repeat(200),
			requestSignature: "rollback-signature-".repeat(200),
			toolDescription: "rollback tool description\n".repeat(200),
		})),
		/injected provider commit failure/u,
	);
	const database = new Database(fixture.dbPath, { readonly: true });
	for (const table of [
		"model_input_blobs",
		"model_input_blob_refs",
		"session_content_blobs",
		"instruction_snapshots",
		"tool_set_snapshots",
		"model_context_events",
		"provider_input_timeline_events",
		"provider_request_manifests",
		"provider_step_events",
	]) assert.equal(count(database, table), 0, table);
	database.close();
});

test("rejects corrupt v11 model-input content without exposing ids or bytes", async (t) => {
	const fixture = await transcriptLedgerFixture(t, SCHEMA_V11_VERSION, "corruption");
	const input = timelineProviderStep({
		payloadText: "private corrupt model input bytes\n".repeat(200),
		requestSignature: "corrupt-signature-".repeat(200),
		toolDescription: "corrupt tool description\n".repeat(200),
	});
	fixture.repository.modelInputLedger.commitProviderStep(input);
	const ownership = modelInputOwnership(fixture.dbPath);
	const database = new Database(fixture.dbPath);
	const content = database.prepare(`
		SELECT content.blob_id, content.stored_bytes
		FROM model_input_blob_refs AS reference
		JOIN session_content_blobs AS content ON content.blob_id = reference.content_blob_id
		WHERE reference.blob_id = ?
	`).get(ownership.requestBlobId) as { readonly blob_id: string; readonly stored_bytes: number };
	database.exec("DROP TRIGGER session_content_blobs_no_update");
	database.prepare(`
		UPDATE session_content_blobs SET payload_blob = zeroblob(?) WHERE blob_id = ?
	`).run(content.stored_bytes, content.blob_id);
	database.close();
	assert.throws(
		() => fixture.repository.modelInputLedger.reconstructProviderStep(input.manifest.requestId),
		(error: unknown) => error instanceof StorageFailure
			&& !error.message.includes(content.blob_id)
			&& !error.message.includes("private corrupt model input bytes")
			&& !JSON.stringify(error.diagnostics).includes(content.blob_id),
	);
});

test("reconstructs exact v12 requests without a logical request blob", async (t) => {
	const fixture = await transcriptLedgerFixture(t, SCHEMA_V12_VERSION, "v12-exact");
	const v2 = timelineProviderStep({
		payloadText: "large append-only provider request\n".repeat(200),
		requestSignature: "v12-signature-".repeat(200),
		toolDescription: "v12 tool description\n".repeat(200),
	});
	const input = v3TimelineProviderStep(v2, v2.timelineEvents ?? []);
	const expected = { manifest: input.manifest, request: input.request };

	assert.deepEqual(fixture.repository.modelInputLedger.commitProviderStep(input), expected);
	assert.deepEqual(fixture.repository.modelInputLedger.commitProviderStep(input), expected);
	assert.deepEqual(
		fixture.repository.modelInputLedger.reconstructProviderStep(input.manifest.requestId),
		expected,
	);

	const requestSha256 = modelInputSha256(input.request);
	const database = new Database(fixture.dbPath, { readonly: true });
	assert.equal(database.prepare(`
		SELECT logical_request_sha256 FROM provider_request_manifests WHERE request_id = ?
	`).pluck().get(input.manifest.requestId), requestSha256);
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM pragma_table_info('provider_request_manifests')
		WHERE name = 'logical_request_blob_id'
	`).pluck().get(), 0);
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM model_input_blobs WHERE blob_id = ?
	`).pluck().get(requestSha256), 0);
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM model_input_blob_refs WHERE blob_id = ?
	`).pluck().get(requestSha256), 0);
	database.close();

	fixture.repository.close();
	const reopened = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath, clock: () => LATER });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.modelInputLedger.loadUnconfirmedProviderSteps("session-1"), [{
		...expected,
		latestEvent: input.preparedEvent,
	}]);
	assert.deepEqual(reopened.modelInputLedger.recoverUnconfirmedProviderSteps({
		sessionId: "session-1",
		createdAt: LATER,
		createEventId: (requestId) => `${requestId}:recovered`,
	}).map((step) => ({ request: step.request, state: step.latestEvent.state })), [{
		request: input.request,
		state: "unknown",
	}]);
});

test("reconstructs legacy cache fields from a v12 timeline manifest", async (t) => {
	const fixture = await transcriptLedgerFixture(t, SCHEMA_V12_VERSION, "v12-legacy-cache");
	const v2 = timelineProviderStep();
	const input = v3TimelineProviderStep(v2, v2.timelineEvents ?? []);
	fixture.repository.modelInputLedger.commitProviderStep(input);
	fixture.repository.close();
	rewriteCacheVocabularyAsLegacy(fixture.dbPath, input, true);

	const reopened = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath, clock: () => NOW });
	t.after(() => reopened.close());
	const reconstructed = reopened.modelInputLedger.reconstructProviderStep(input.manifest.requestId);
	assert.deepEqual(reconstructed.request, input.request);
	assert.deepEqual(reconstructed.manifest.providerConfig, input.manifest.providerConfig);
});

test("keeps older v12 timeline prefixes exact after later appends", async (t) => {
	const fixture = await transcriptLedgerFixture(t, SCHEMA_V12_VERSION, "v12-prefix");
	const firstV2 = timelineProviderStep();
	const first = v3TimelineProviderStep(firstV2, firstV2.timelineEvents ?? []);
	const secondV2 = continuedTimelineProviderStep(firstV2);
	const completeTimeline = Object.freeze([
		...(first.timelineEvents ?? []),
		...(secondV2.timelineEvents ?? []),
	]);
	const second = v3TimelineProviderStep(secondV2, completeTimeline);
	const firstExpected = { manifest: first.manifest, request: first.request };
	const secondExpected = { manifest: second.manifest, request: second.request };

	assert.deepEqual(fixture.repository.modelInputLedger.commitProviderStep(first), firstExpected);
	assert.deepEqual(fixture.repository.modelInputLedger.commitProviderStep(second), secondExpected);
	assert.deepEqual(
		fixture.repository.modelInputLedger.reconstructProviderStep(first.manifest.requestId),
		firstExpected,
	);
	assert.deepEqual(
		fixture.repository.modelInputLedger.reconstructProviderStep(second.manifest.requestId),
		secondExpected,
	);
});

test("reconstructs a compacted v12 request only from its new window", async (t) => {
	const fixture = await transcriptLedgerFixture(t, SCHEMA_V12_VERSION, "v12-compaction");
	const firstV2 = timelineProviderStep();
	const first = v3TimelineProviderStep(firstV2, firstV2.timelineEvents ?? []);
	const compacted = compactedV3ProviderStep(first);

	fixture.repository.modelInputLedger.commitProviderStep(first);
	const committed = fixture.repository.modelInputLedger.commitProviderStep(compacted);
	assert.deepEqual(committed.request, compacted.request);
	assert.equal(committed.manifest.boundary, "compaction");
	assert.equal(committed.request.items?.some((item) => (
		item.type === "user" && item.text === "Inspect the repository."
	)), false);
	assert.equal(committed.request.items?.some((item) => (
		item.type === "user" && item.text.startsWith("[compact-summary]")
	)), true);
	assert.deepEqual(
		fixture.repository.modelInputLedger.reconstructProviderStep(first.manifest.requestId).request,
		first.request,
	);
});

test("fails v12 recovery before dispatch on timeline or request-hash corruption", async (t) => {
	for (const corruption of ["timeline", "request_hash"] as const) {
		const fixture = await transcriptLedgerFixture(t, SCHEMA_V12_VERSION, `v12-${corruption}`);
		const v2 = timelineProviderStep();
		const input = v3TimelineProviderStep(v2, v2.timelineEvents ?? []);
		fixture.repository.modelInputLedger.commitProviderStep(input);
		fixture.repository.close();

		const database = new Database(fixture.dbPath);
		if (corruption === "timeline") {
			database.exec("DROP TRIGGER provider_input_timeline_events_no_delete");
			database.prepare(`
				DELETE FROM provider_input_timeline_events WHERE event_id = ?
			`).run("timeline-context-1");
		} else {
			database.exec("DROP TRIGGER provider_request_manifests_no_update");
			database.prepare(`
				UPDATE provider_request_manifests SET logical_request_sha256 = ? WHERE request_id = ?
			`).run("0".repeat(64), input.manifest.requestId);
		}
		database.close();

		const reopened = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath, clock: () => LATER });
		t.after(() => reopened.close());
		let dispatchCount = 0;
		assert.throws(() => {
			const pending = reopened.modelInputLedger.loadUnconfirmedProviderSteps("session-1");
			dispatchCount += pending.length;
		}, StorageFailure);
		assert.equal(dispatchCount, 0);
		reopened.close();
	}
});

test("v12 rejects repeated-prefix v2 manifests without partial model-input writes", async (t) => {
	const fixture = await transcriptLedgerFixture(t, SCHEMA_V12_VERSION, "v12-v2-rejected");
	assert.throws(
		() => fixture.repository.modelInputLedger.commitProviderStep(timelineProviderStep()),
		/timeline-backed provider requests require a v3 manifest/u,
	);
	const database = new Database(fixture.dbPath, { readonly: true });
	for (const table of [
		"model_input_blobs",
		"model_input_blob_refs",
		"instruction_snapshots",
		"tool_set_snapshots",
		"model_context_events",
		"provider_input_timeline_events",
		"provider_request_manifests",
		"provider_step_events",
	]) assert.equal(count(database, table), 0, table);
	database.close();
});

test("stores hundreds of growing v12 tool steps without full-request ownership", {
	timeout: 30_000,
}, async (t) => {
	const fixture = await transcriptLedgerFixture(t, SCHEMA_V12_VERSION, "v12-growth");
	const instructions = instructionSnapshot();
	const toolSet = toolSetSnapshot("Read a file for the append-only growth benchmark.");
	const providerConfig = Object.freeze({
		provider: "openai" as const,
		protocol: "responses" as const,
		model: "gpt-test",
	});
	const windowId = "window-growth";
	const boundary: ProviderInputTimelineEvent = Object.freeze({
		eventId: "timeline-growth-boundary",
		sessionId: "session-1",
		windowId,
		turnId: "turn-growth-0",
		providerStep: 0,
		kind: "window_boundary",
		boundary: "bootstrap",
		contentSha256: modelInputSha256({ window_id: windowId, boundary: "bootstrap" }),
		createdAt: NOW,
	});
	const timeline: ProviderInputTimelineEvent[] = [boundary];
	const items: CanonicalConversationItem[] = [];
	const expected = new Map<number, ProviderRequest>();
	let previousManifestId: string | undefined;
	let cumulativeRequestBytes = 0;
	const bootstrapPrefixSha256 = modelInputSha256({
		instruction_snapshot_sha256: instructions.contentSha256,
		tool_set_snapshot_sha256: toolSet.contentSha256,
		items: [],
	});
	const requestConfigurationSha256 = modelInputSha256({
		provider_config: providerConfig,
		instruction_snapshot_sha256: instructions.contentSha256,
		tool_set_snapshot_sha256: toolSet.contentSha256,
	});

	for (let step = 0; step < 250; step += 1) {
		const item: CanonicalConversationItem = step === 0
			? Object.freeze({ type: "user", text: "Run the tool-heavy growth fixture." })
			: step % 2 === 1
				? Object.freeze({
					type: "assistant_tool_calls",
					text: "",
					calls: Object.freeze([Object.freeze({
						callId: `call-growth-${Math.ceil(step / 2)}`,
						name: "Read",
						argumentsJson: `{"path":"fixture-${step}.txt"}`,
					})]),
				})
				: Object.freeze({
					type: "tool_result",
					callId: `call-growth-${step / 2}`,
					toolName: "Read",
					output: `tool-result-${step}\n${"repeated output ".repeat(128)}`,
					success: true,
				});
		items.push(item);
		const createdAt = new Date(Date.parse(NOW) + step).toISOString();
		const event: ProviderInputTimelineEvent = Object.freeze({
			eventId: `timeline-growth-${step}`,
			sessionId: "session-1",
			windowId,
			turnId: `turn-growth-${step}`,
			providerStep: step,
			kind: "conversation_item",
			item,
			sourceIndex: step,
			contentSha256: modelInputSha256(item),
			createdAt,
		});
		timeline.push(event);
		const request = projectProviderRequest({
			config: providerConfig,
			instructions: instructions.content,
			history: items,
			tools: toolSet.tools,
		});
		cumulativeRequestBytes += Buffer.byteLength(JSON.stringify(request));
		const timelineSha256 = modelInputSha256(items);
		const requestId = `request-growth-${step}`;
		const manifest: ProviderRequestManifestV3 = Object.freeze({
			schemaVersion: 3,
			requestId,
			sessionId: "session-1",
			turnId: `turn-growth-${step}`,
			providerStep: step,
			providerConfig,
			instructionSnapshotId: instructions.snapshotId,
			toolSetSnapshotId: toolSet.snapshotId,
			requestSignature: "growth-request-signature",
			logicalInputSha256: manifestTimelineLogicalInputSha256(
				instructions,
				toolSet,
				timelineSha256,
			),
			contextPrefixSha256: bootstrapPrefixSha256,
			...(previousManifestId ? { previousManifestId } : { boundary: "bootstrap" as const }),
			timelineWindowId: windowId,
			timelineEventCount: timeline.length,
			timelinePrefixSha256: providerTimelinePrefixSha256(timeline),
			requestConfigurationSha256,
			bootstrapPrefixSha256,
			timelineSha256,
			commonPrefixItemCount: Math.max(0, items.length - 1),
			createdAt,
		});
		const input: ProviderStepInputV3 = Object.freeze({
			instructionSnapshot: instructions,
			toolSetSnapshot: toolSet,
			contextEvents: Object.freeze([]),
			timelineEvents: Object.freeze(step === 0 ? [boundary, event] : [event]),
			manifest,
			request,
			preparedEvent: lifecycleEvent(
				`${requestId}:prepared`,
				"prepared",
				createdAt,
				requestId,
			),
		});
		assert.deepEqual(fixture.repository.modelInputLedger.commitProviderStep(input).request, request);
		if (step === 0 || step === 124 || step === 249) expected.set(step, request);
		previousManifestId = requestId;
	}

	for (const [step, request] of expected) {
		assert.deepEqual(
			fixture.repository.modelInputLedger.reconstructProviderStep(`request-growth-${step}`).request,
			request,
		);
	}
	const database = new Database(fixture.dbPath, { readonly: true });
	assert.equal(count(database, "provider_request_manifests"), 250);
	assert.equal(count(database, "provider_input_timeline_events"), 251);
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM provider_request_manifests AS manifest
		JOIN model_input_blobs AS blob ON blob.blob_id = manifest.logical_request_sha256
	`).pluck().get(), 0);
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM provider_request_manifests AS manifest
		JOIN model_input_blob_refs AS reference ON reference.blob_id = manifest.logical_request_sha256
	`).pluck().get(), 0);
	assert.ok(count(database, "model_input_blobs") <= 2 * 250 + 3);
	const allocatedBytes = Number(database.pragma("page_count", { simple: true }))
		* Number(database.pragma("page_size", { simple: true }));
	assert.ok(
		allocatedBytes < cumulativeRequestBytes,
		`allocated=${allocatedBytes} cumulative_requests=${cumulativeRequestBytes}`,
	);
	database.close();
});

function providerStep(options: {
	readonly requestId?: string;
	readonly providerStep?: number;
	readonly previousManifestId?: string;
	readonly boundary?: ProviderRequestManifest["boundary"];
	readonly contextEvents?: readonly ModelContextEvent[];
	readonly createdAt?: string;
	readonly payloadText?: string;
	readonly requestSignature?: string;
	readonly toolDescription?: string;
} = {}): ProviderStepInputV1 {
	const createdAt = options.createdAt ?? NOW;
	const providerStep = options.providerStep ?? 0;
	const requestId = options.requestId ?? "request-1";
	const payloadText = options.payloadText ?? "Inspect the repository.";
	const instructions = instructionSnapshot(options.payloadText ?? "You are mycli.");
	const toolSet = toolSetSnapshot(options.toolDescription);
	const contextEvents = options.contextEvents ?? [contextEvent({
		eventId: "context-1",
		providerStep,
		createdAt,
		...(options.payloadText ? { content: options.payloadText } : {}),
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
			contentSha256: modelInputSha256(payloadText),
		},
	];
	const request: ProviderRequest = {
		provider: "openai",
		protocol: "responses",
		model: "gpt-5.5",
		instructions: instructions.content,
		messages: [{ role: "user", content: payloadText }],
		items: [{ type: "user", text: payloadText }],
		tools: toolSet.tools,
		sessionId: "session-1",
		cacheRetention: "short",
	};
	const manifest: ProviderRequestManifestV1 = {
		schemaVersion: 1,
		requestId,
		sessionId: "session-1",
		turnId: "turn-1",
		providerStep,
		providerConfig: {
			provider: request.provider,
			protocol: request.protocol,
			model: request.model,
			sessionId: request.sessionId,
			cacheRetention: request.cacheRetention,
		},
		instructionSnapshotId: instructions.snapshotId,
		toolSetSnapshotId: toolSet.snapshotId,
		orderedItems,
		requestSignature: options.requestSignature ?? "sha256:request-signature",
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

function timelineProviderStep(options: {
	readonly payloadText?: string;
	readonly requestSignature?: string;
	readonly toolDescription?: string;
} = {}): ProviderStepInputV2 {
	const base = providerStep({ requestId: "request-timeline", ...options });
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
	const userItem = Object.freeze({
		type: "user" as const,
		text: options.payloadText ?? "Inspect the repository.",
	});
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
	const manifest: ProviderRequestManifestV2 = Object.freeze({
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

function continuedTimelineProviderStep(previous: ProviderStepInputV2): ProviderStepInputV2 {
	const previousTimeline = previous.timelineEvents ?? [];
	const priorManifest = previous.manifest;
	if (priorManifest.schemaVersion !== 2) {
		throw new Error("continued timeline fixture requires a v2 manifest");
	}
	const windowId = priorManifest.timelineWindowId;
	const assistantItem = Object.freeze({
		type: "assistant" as const,
		text: "later timeline assistant payload\n".repeat(200),
	});
	const appendedEvent: ProviderInputTimelineEvent = Object.freeze({
		eventId: "timeline-assistant-2",
		sessionId: "session-1",
		windowId,
		turnId: "turn-2",
		providerStep: 1,
		kind: "conversation_item",
		item: assistantItem,
		sourceIndex: 1,
		contentSha256: modelInputSha256(assistantItem),
		createdAt: LATER,
	});
	const allItems = Object.freeze([
		...previousTimeline.flatMap((event) => event.item ? [event.item] : []),
		assistantItem,
	]);
	const orderedItems: readonly ModelInputReference[] = Object.freeze([
		...previous.manifest.orderedItems,
		{
			kind: "provider_timeline_event",
			id: appendedEvent.eventId,
			contentSha256: appendedEvent.contentSha256,
		},
	]);
	const request: ProviderRequest = Object.freeze({
		...previous.request,
		messages: Object.freeze([
			previous.request.messages[0]!,
			{ role: "assistant" as const, content: assistantItem.text },
		]),
		items: allItems,
	});
	const { boundary: _boundary, ...previousManifest } = priorManifest;
	void _boundary;
	const manifest: ProviderRequestManifestV2 = Object.freeze({
		...previousManifest,
		requestId: "request-timeline-2",
		turnId: "turn-2",
		providerStep: 1,
		orderedItems,
		requestSignature: "later-request-signature-".repeat(200),
		logicalInputSha256: manifestLogicalInputSha256(
			previous.instructionSnapshot,
			previous.toolSetSnapshot,
			orderedItems,
		),
		previousManifestId: priorManifest.requestId,
		timelineEventIds: [...priorManifest.timelineEventIds, appendedEvent.eventId],
		timelineSha256: modelInputSha256(allItems),
		commonPrefixItemCount: allItems.length - 1,
		createdAt: LATER,
	});
	return Object.freeze({
		instructionSnapshot: previous.instructionSnapshot,
		toolSetSnapshot: previous.toolSetSnapshot,
		contextEvents: Object.freeze([]),
		timelineEvents: Object.freeze([appendedEvent]),
		manifest,
		request,
		preparedEvent: lifecycleEvent(
			"request-timeline-2:prepared",
			"prepared",
			LATER,
			"request-timeline-2",
		),
	});
}

function v3TimelineProviderStep(
	input: ProviderStepInputV2,
	completeTimeline: readonly ProviderInputTimelineEvent[],
): ProviderStepInputV3 {
	const {
		schemaVersion: _schemaVersion,
		orderedItems: _orderedItems,
		timelineEventIds: _timelineEventIds,
		...baseManifest
	} = input.manifest;
	void _schemaVersion;
	void _orderedItems;
	void _timelineEventIds;
	const timelineSha256 = modelInputSha256(input.request.items ?? []);
	const manifest: ProviderRequestManifestV3 = Object.freeze({
		...baseManifest,
		schemaVersion: 3,
		logicalInputSha256: manifestTimelineLogicalInputSha256(
			input.instructionSnapshot,
			input.toolSetSnapshot,
			timelineSha256,
		),
		timelineEventCount: completeTimeline.length,
		timelinePrefixSha256: providerTimelinePrefixSha256(completeTimeline),
		requestConfigurationSha256: modelInputSha256({
			provider_config: input.manifest.providerConfig,
			instruction_snapshot_sha256: input.instructionSnapshot.contentSha256,
			tool_set_snapshot_sha256: input.toolSetSnapshot.contentSha256,
		}),
		timelineSha256,
	});
	return Object.freeze({ ...input, manifest });
}

function compactedV3ProviderStep(previous: ProviderStepInputV3): ProviderStepInputV3 {
	const context = (previous.timelineEvents ?? []).find((event) => event.kind === "context_update");
	if (!context?.item || !context.modelContextEventId) {
		throw new Error("compaction fixture requires an active context event");
	}
	const windowId = "window-2-compaction";
	const summary = Object.freeze({
		type: "user" as const,
		text: "[compact-summary]\nThe repository inspection request was summarized.",
	});
	const current = Object.freeze({ type: "user" as const, text: "Continue after compaction." });
	const timelineEvents: readonly ProviderInputTimelineEvent[] = Object.freeze([
		Object.freeze({
			eventId: "timeline-boundary-2",
			sessionId: "session-1",
			windowId,
			turnId: "turn-2",
			providerStep: 1,
			kind: "window_boundary",
			boundary: "compaction",
			contentSha256: modelInputSha256({ window_id: windowId, boundary: "compaction" }),
			createdAt: LATER,
		}),
		Object.freeze({
			eventId: "timeline-context-2",
			sessionId: "session-1",
			windowId,
			turnId: "turn-2",
			providerStep: 1,
			kind: "context_update",
			item: context.item,
			modelContextEventId: context.modelContextEventId,
			contentSha256: modelInputSha256(context.item),
			createdAt: LATER,
		}),
		...([summary, current] as const).map((item, sourceIndex) => Object.freeze({
			eventId: `timeline-compacted-${sourceIndex + 1}`,
			sessionId: "session-1",
			windowId,
			turnId: "turn-2",
			providerStep: 1,
			kind: "conversation_item" as const,
			item,
			sourceIndex,
			contentSha256: modelInputSha256(item),
			createdAt: LATER,
		})),
	]);
	const items = Object.freeze(timelineEvents.flatMap((event) => event.item ? [event.item] : []));
	const request = projectProviderRequest({
		config: previous.manifest.providerConfig,
		instructions: previous.instructionSnapshot.content,
		history: items,
		tools: previous.toolSetSnapshot.tools,
	});
	const timelineSha256 = modelInputSha256(items);
	const bootstrapPrefixSha256 = modelInputSha256({
		instruction_snapshot_sha256: previous.instructionSnapshot.contentSha256,
		tool_set_snapshot_sha256: previous.toolSetSnapshot.contentSha256,
		items: [context.item],
	});
	const manifest: ProviderRequestManifestV3 = Object.freeze({
		schemaVersion: 3,
		requestId: "request-compacted",
		sessionId: "session-1",
		turnId: "turn-2",
		providerStep: 1,
		providerConfig: previous.manifest.providerConfig,
		instructionSnapshotId: previous.instructionSnapshot.snapshotId,
		toolSetSnapshotId: previous.toolSetSnapshot.snapshotId,
		requestSignature: "compacted-request-signature",
		logicalInputSha256: manifestTimelineLogicalInputSha256(
			previous.instructionSnapshot,
			previous.toolSetSnapshot,
			timelineSha256,
		),
		contextPrefixSha256: bootstrapPrefixSha256,
		previousManifestId: previous.manifest.requestId,
		boundary: "compaction",
		timelineWindowId: windowId,
		timelineEventCount: timelineEvents.length,
		timelinePrefixSha256: providerTimelinePrefixSha256(timelineEvents),
		requestConfigurationSha256: modelInputSha256({
			provider_config: previous.manifest.providerConfig,
			instruction_snapshot_sha256: previous.instructionSnapshot.contentSha256,
			tool_set_snapshot_sha256: previous.toolSetSnapshot.contentSha256,
		}),
		bootstrapPrefixSha256,
		timelineSha256,
		commonPrefixItemCount: 0,
		createdAt: LATER,
	});
	return Object.freeze({
		instructionSnapshot: previous.instructionSnapshot,
		toolSetSnapshot: previous.toolSetSnapshot,
		contextEvents: Object.freeze([]),
		timelineEvents,
		manifest,
		request,
		preparedEvent: lifecycleEvent(
			"request-compacted:prepared",
			"prepared",
			LATER,
			"request-compacted",
		),
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

function toolSetSnapshot(description = "Read a file."): ToolSetSnapshot {
	const tools: readonly ToolDefinition[] = [Object.freeze({
		id: "Read",
		name: "Read",
		description,
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

function rewriteCacheVocabularyAsLegacy(
	dbPath: string,
	input: ProviderStepInputV2 | ProviderStepInputV3,
	contentBacked: boolean,
): void {
	const legacyConfig = legacyCacheShape(input.manifest.providerConfig);
	const legacyRequest = legacyCacheShape(input.request);
	const requestConfigurationSha256 = input.manifest.schemaVersion === 3
		? modelInputSha256({
			provider_config: legacyConfig,
			instruction_snapshot_sha256: input.instructionSnapshot.contentSha256,
			tool_set_snapshot_sha256: input.toolSetSnapshot.contentSha256,
		})
		: modelInputSha256(legacyConfig);
	const manifestBlob = modelInputBlob({
		...input.manifest,
		providerConfig: legacyConfig,
		requestConfigurationSha256,
	});
	const requestBlob = modelInputBlob(legacyRequest);
	const database = new Database(dbPath);
	try {
		putLegacyModelInputBlob(database, manifestBlob, contentBacked);
		if (!contentBacked) putLegacyModelInputBlob(database, requestBlob, false);
		database.exec("DROP TRIGGER provider_request_manifests_no_update");
		if (contentBacked) {
			database.prepare(`
				UPDATE provider_request_manifests
				SET manifest_blob_id = ?, logical_request_sha256 = ?
				WHERE request_id = ?
			`).run(manifestBlob.id, requestBlob.id, input.manifest.requestId);
		} else {
			database.prepare(`
				UPDATE provider_request_manifests
				SET manifest_blob_id = ?, logical_request_blob_id = ?, logical_request_sha256 = ?
				WHERE request_id = ?
			`).run(manifestBlob.id, requestBlob.id, requestBlob.id, input.manifest.requestId);
		}
	} finally {
		database.close();
	}
}

function legacyCacheShape(value: object): Readonly<Record<string, unknown>> {
	const {
		sessionId,
		cacheRetention,
		...rest
	} = value as Readonly<Record<string, unknown>>;
	assert.equal(typeof sessionId, "string");
	assert.equal(cacheRetention, "short");
	return Object.freeze({
		...rest,
		store: false,
		promptCacheKey: sessionId,
		cacheControlEnabled: true,
	});
}

function putLegacyModelInputBlob(
	database: Database.Database,
	blob: ReturnType<typeof modelInputBlob>,
	contentBacked: boolean,
): void {
	if (!contentBacked) {
		database.prepare(`
			INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
			VALUES (?, ?, ?)
		`).run(blob.id, blob.json, NOW);
		return;
	}
	const content = encodeSessionContentBlob(blob.json);
	database.prepare(`
		INSERT INTO session_content_blobs (
			blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		content.blobId,
		content.codec,
		content.rawBytes,
		content.storedBytes,
		content.payload,
		NOW,
	);
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at)
		VALUES (?, ?, ?)
	`).run(blob.id, MODEL_INPUT_CONTENT_BLOB_MARKER_JSON, NOW);
	database.prepare(`
		INSERT INTO model_input_blob_refs (blob_id, content_blob_id)
		VALUES (?, ?)
	`).run(blob.id, content.blobId);
}

async function transcriptLedgerFixture(
	t: test.TestContext,
	version:
		| typeof SCHEMA_V10_VERSION
		| typeof SCHEMA_V11_VERSION
		| typeof SCHEMA_V12_VERSION,
	name: string,
	options: Readonly<{
		readonly modelInputFailpoint?: (name: ModelInputLedgerFailpoint) => void;
	}> = {},
): Promise<Readonly<{
	readonly dbPath: string;
	readonly repository: SQLiteTranscriptEventRepository;
}>> {
	const root = await mkdtemp(join(tmpdir(), `mycli-model-input-${name}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	const repository = new SQLiteTranscriptEventRepository({
		dbPath,
		initializeSchemaVersion: version,
		clock: () => NOW,
		...(options.modelInputFailpoint
			? { modelInputFailpoint: options.modelInputFailpoint }
			: {}),
	});
	t.after(() => repository.close());
	repository.reserveTurn({
		sessionId: "session-1",
		clientTurnId: "client-turn-1",
		clientUserMessageId: "user-message-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: root,
		threadId: "thread-1",
		userText: "Inspect the repository.",
		startedAt: NOW,
	});
	return Object.freeze({ dbPath, repository });
}

interface ModelInputOwnership {
	readonly instructionBlobId: string;
	readonly toolSetBlobId: string;
	readonly contextBlobIds: readonly string[];
	readonly timelineBlobIds: readonly string[];
	readonly manifestBlobId: string;
	readonly requestBlobId: string;
}

function modelInputOwnership(dbPath: string): ModelInputOwnership {
	const database = new Database(dbPath, { readonly: true });
	try {
		const scalarText = (sql: string): string => String(database.prepare(sql).pluck().get());
		const textRows = (sql: string): readonly string[] => Object.freeze(
			(database.prepare(sql).pluck().all() as readonly unknown[]).map(String),
		);
		return Object.freeze({
			instructionBlobId: scalarText(`
				SELECT blob_id FROM instruction_snapshots ORDER BY rowid LIMIT 1
			`),
			toolSetBlobId: scalarText(`
				SELECT blob_id FROM tool_set_snapshots ORDER BY rowid LIMIT 1
			`),
			contextBlobIds: textRows(`
				SELECT blob_id FROM model_context_events ORDER BY rowid
			`),
			timelineBlobIds: textRows(`
				SELECT blob_id FROM provider_input_timeline_events ORDER BY sequence_no
			`),
			manifestBlobId: scalarText(`
				SELECT manifest_blob_id FROM provider_request_manifests ORDER BY rowid LIMIT 1
			`),
			requestBlobId: scalarText(`
				SELECT logical_request_blob_id FROM provider_request_manifests ORDER BY rowid LIMIT 1
			`),
		});
	} finally {
		database.close();
	}
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

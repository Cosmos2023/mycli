import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { removeFixtureDirectoryAfterTests } from "../../../storage/test/fixtures/directory-cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelInputSha256 } from "@mycli/core";
import { SQLiteSessionStore, StorageFailure } from "@mycli/storage";
import {
	NodeTurnCoordinatorBroker,
	type AgentToolAttempt,
} from "../../src/index.ts";

const NOW = "2026-08-12T00:00:00.000Z";

test("deduplicates identical provider lifecycle acknowledgements", async (t) => {
	const fixture = await brokerFixture(t);
	const committed = fixture.broker.commitProviderStep(providerStepInput());

	fixture.broker.recordProviderStep(committed.manifest.requestId, "dispatch_started", {
		provider_step: 1,
	});
	fixture.broker.recordProviderStep(committed.manifest.requestId, "acknowledged", {
		response_id_present: true,
	});
	fixture.broker.recordProviderStep(committed.manifest.requestId, "acknowledged", {
		response_id_present: true,
	});

	assert.deepEqual(
		fixture.store.modelInputLedger.loadProviderStepEvents(committed.manifest.requestId)
			.map((event) => event.state),
		["prepared", "dispatch_started", "acknowledged"],
	);
});

test("returns a committed tool result without executing a duplicate attempt", async (t) => {
	const fixture = await brokerFixture(t);
	const input = toolAttempt();
	let effects = 0;
	const execute = async () => {
		effects += 1;
		return Object.freeze({
			callId: "call-1",
			toolName: "Read",
			success: true,
			modelOutput: "contents",
			images: [{ mediaType: "image/png" as const, data: "aW1hZ2U=" }],
			summary: "Read file",
			metadata: Object.freeze({ path: "README.md" }),
		});
	};

	const first = await fixture.broker.executeTool(input, execute);
	const duplicate = await fixture.broker.executeTool(input, execute);

	assert.equal(effects, 1);
	assert.deepEqual(duplicate, first);
	assert.equal(
		fixture.store.agentEffectLedger.load(input.attemptId)?.state,
		"completed",
	);

	fixture.store.close();
	const reopened = sessionStore(fixture.dbPath);
	t.after(() => reopened.close());
	const reopenedBroker = new NodeTurnCoordinatorBroker({
		sessionId: "session-1",
		ledger: reopened.modelInputLedger,
		effectLedger: reopened.agentEffectLedger,
		clock: () => NOW,
	});
	assert.deepEqual(await reopenedBroker.executeTool(input, execute), first);
	assert.equal(effects, 1);
});

test("terminalizes a thrown mutating tool as unknown and never replays it", async (t) => {
	const fixture = await brokerFixture(t);
	const input = { ...toolAttempt(), mutating: true };
	let effects = 0;

	await assert.rejects(fixture.broker.executeTool(input, async () => {
		effects += 1;
		throw new Error("write transport disconnected");
	}), /write transport disconnected/u);
	assert.equal(
		fixture.store.agentEffectLedger.load(input.attemptId)?.state,
		"effect_outcome_unknown",
	);
	await assert.rejects(
		fixture.broker.executeTool(input, async () => {
			effects += 1;
			throw new Error("must not execute");
		}),
		(error: unknown) => error instanceof StorageFailure
			&& /not replayable: effect_outcome_unknown/u.test(error.message),
	);
	assert.equal(effects, 1);
});

function toolAttempt(): AgentToolAttempt {
	return Object.freeze({
		attemptId: "attempt-tool-1",
		jobId: "job-1",
		turnId: "turn-1",
		base: Object.freeze({ windowId: "window-1", version: 1 }),
		call: Object.freeze({
			callId: "call-1",
			name: "Read",
			argumentsJson: "{\"path\":\"README.md\"}",
		}),
		mutating: false,
	});
}

function providerStepInput() {
	const instructions = Object.freeze({
		snapshotId: "instructions-1",
		version: "v1",
		source: "test",
		content: "You are mycli.",
		contentSha256: modelInputSha256("You are mycli."),
		createdAt: NOW,
	});
	return Object.freeze({
		turnId: "turn-1",
		providerStep: 1,
		requestConfig: Object.freeze({
			provider: "openai" as const,
			protocol: "responses" as const,
			model: "test-model",
		}),
		instructionSnapshot: instructions,
		tools: Object.freeze([]),
		history: Object.freeze([{ type: "user" as const, text: "hello" }]),
		currentUserRequest: "hello",
		sources: Object.freeze({}),
		maxPromptTokens: 8_000,
	});
}

async function brokerFixture(t: test.TestContext): Promise<{
	readonly store: SQLiteSessionStore;
	readonly broker: NodeTurnCoordinatorBroker;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-turn-broker-"));
	removeFixtureDirectoryAfterTests(t, root);
	const dbPath = join(root, "sessions.db");
	const store = sessionStore(dbPath);
	t.after(() => store.close());
	store.reserveTurn({
		sessionId: "session-1",
		clientTurnId: "client-turn-1",
		clientUserMessageId: "user-message-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: root,
		threadId: "thread-1",
		userText: "hello",
		startedAt: NOW,
	});
	let sequence = 0;
	const broker = new NodeTurnCoordinatorBroker({
		sessionId: "session-1",
		ledger: store.modelInputLedger,
		effectLedger: store.agentEffectLedger,
		clock: () => NOW,
		createId: (kind) => `${kind}-${++sequence}`,
	});
	return { store, broker, dbPath };
}

function sessionStore(dbPath: string): SQLiteSessionStore {
	return new SQLiteSessionStore({ dbPath, clock: () => NOW });
}

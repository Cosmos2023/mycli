import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { removeFixtureDirectoryAfterTests } from "../../../storage/test/fixtures/directory-cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NODE_RUNTIME_CONTEXT_DEFAULTS, type NodeRuntimeConfig } from "@mycli/config";
import { readErrorContext } from "@mycli/contracts";
import type { RuntimeEvent } from "@mycli/core";
import { ProviderFailure } from "@mycli/providers";
import { SQLiteTranscriptEventRepository, StorageFailure } from "@mycli/storage";
import { NodeTurnRuntime, type NodeTurnRuntimeOptions } from "../../src/index.ts";
import { projectCommittedTurnTerminalization } from "../../src/turns/turn-terminalization.ts";

for (const scenario of [
	{ failure: undefined, reason: undefined },
	{ failure: new Error("fixture failure"), reason: "storage.write_failed" },
	{ failure: new StorageFailure("fixture lock", { sqlite_code: "SQLITE_BUSY" }), reason: "storage.busy" },
	{ failure: new StorageFailure("fixture full", { sqlite_code: "SQLITE_FULL" }), reason: "storage.capacity_exceeded" },
]) test(`terminal failure retains its cause when commit fails: ${scenario.reason ?? "none"}`, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-error-boundary-"));
	removeFixtureDirectoryAfterTests(t, root);
	let commits = 0;
	const store = new SQLiteTranscriptEventRepository({ dbPath: join(root, "session.db"), initializeSchemaVersion: 14,
		turnTerminalizationFailpoint: (name) => { if (name === "failure_after_display") {
			commits += 1;
			if (scenario.failure) throw scenario.failure;
		} },
	});
	t.after(() => store.close());
	const events: RuntimeEvent[] = [];
	const diagnostics: unknown[] = [];
	const providerFailure = new ProviderFailure({ code: "auth_error", message: "private error",
		errorReason: { reason: "auth.credentials_missing" }, outcome: { state: "not_started", effects: "none" },
	});
	const runtime = runtimeFor(root, store, { recordDiagnostic: (event) => diagnostics.push(event),
		createProvider: () => ({ stream: () => { throw providerFailure; } }),
	});
	const run = runtime.submit({ clientTurnId: "client:error", message: "test" }, (event) => events.push(event), { signal: new AbortController().signal });
	if (scenario.failure) {
		await assert.rejects(run);
		assert.equal(store.loadTurn("session:error", "client:error")?.status, "in_progress");
		const failure = events.find((event) => event.type === "runtime_error");
		assert.ok(failure?.type === "runtime_error");
		assert.equal(failure.errorContext?.reason, scenario.reason);
		assert.deepEqual(failure.errorContext?.scope, { kind: "turn", id: "turn:error" });
		assert.equal(failure.errorContext?.outcome.state, "unknown");
		assert.equal(failure.errorContext?.causes?.[0]?.id, providerFailure.errorId);
		assert.equal(events.some((event) => event.type === "turn_failed"), false);
		assert.equal(store.loadReadableTranscript("session:error").some((item) => item.type === "error"), false);
		assert.equal(diagnostics.length > 0, true);
	} else {
		const turn = await run;
		assert.equal(turn.status, "failed");
		assert.equal(readErrorContext(turn.result?.error_context)?.id, providerFailure.errorId);
		assert.equal(readErrorContext(turn.result?.error_context)?.reason, "auth.credentials_missing");
	}
	assert.equal(commits, 1, "emergency reporting must not retry persistence recursively");
});

test("a failed readable projection cannot replace an already committed successful turn", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-error-projection-"));
	removeFixtureDirectoryAfterTests(t, root);
	const store = new SQLiteTranscriptEventRepository({ dbPath: join(root, "session.db"), initializeSchemaVersion: 14 });
	t.after(() => store.close());
	const diagnostics: unknown[] = [];
	const events: RuntimeEvent[] = [];
	const runtime = runtimeFor(root, store, {
		writeTerminalSnapshot: async () => { throw new Error("fixture projection failure"); },
		recordDiagnostic: (event) => diagnostics.push(event),
	});
	const turn = await runtime.submit({ clientTurnId: "client:error", message: "test" }, (event) => events.push(event), { signal: new AbortController().signal });
	assert.equal(turn.status, "completed");
	assert.equal(events.some((event) => event.type === "turn_failed"), false);
	assert.equal(JSON.stringify(diagnostics).includes('"operation":"projection"'), true);
	assert.equal(store.loadTurn("session:error", "client:error")?.status, "completed");
});

for (const failProvider of [false, true]) test(`disconnect after terminal commit preserves the result without replay: ${failProvider}`, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-error-disconnect-"));
	removeFixtureDirectoryAfterTests(t, root);
	const dbPath = join(root, "session.db");
	const store = new SQLiteTranscriptEventRepository({ dbPath, initializeSchemaVersion: 14 });
	t.after(() => store.close());
	let requests = 0;
	const providerFailure = new ProviderFailure({ code: "auth_error", message: "fixture error", errorReason: { reason: "auth.credentials_missing" } });
	const overrides: Partial<NodeTurnRuntimeOptions> = { createProvider: () => ({ stream: async function* () {
		requests += 1;
		if (failProvider) throw providerFailure;
		yield { type: "text_delta", text: "done" };
		yield { type: "completed" };
	} }) };
	const runtime = runtimeFor(root, store, overrides);
	const events: RuntimeEvent[] = [];
	const disconnect = new Error("fixture disconnected");
	await runtime.submit({ clientTurnId: "client:error", message: "test" }, (event) => {
		events.push(event);
		if (event.type === "turn_failed" || event.type === "turn_completed") throw disconnect;
	}, { signal: new AbortController().signal }).catch((error: unknown) => { assert.equal(error, disconnect); });
	assert.equal(events.some((event) => event.type === "runtime_error"), false, "delivery failure is not a storage commit failure");
	const committed = store.turnTerminalizations.load("session:error", "client:error");
	assert.ok(committed);
	assert.equal(committed.turn.status, failProvider ? "failed" : "completed");
	assert.equal(readErrorContext(committed.turn.result?.error_context)?.id, failProvider ? providerFailure.errorId : undefined);
	const before = store.loadEventWindow("session:error", { limit: 100 }).events;
	store.close();
	const reopened = new SQLiteTranscriptEventRepository({ dbPath });
	t.after(() => reopened.close());
	const resumed = await runtimeFor(root, reopened, overrides).submit(
		{ clientTurnId: "client:error", message: "test" }, () => {}, { signal: new AbortController().signal },
	);
	assert.deepEqual(resumed, committed.turn);
	assert.deepEqual(reopened.loadEventWindow("session:error", { limit: 100 }).events, before);
	assert.deepEqual(projectCommittedTurnTerminalization(committed), events.find((event) => event.type === "turn_failed" || event.type === "turn_completed"));
	assert.equal(requests, 1);
});

function runtimeFor(root: string, store: SQLiteTranscriptEventRepository, overrides: Partial<NodeTurnRuntimeOptions> = {}): NodeTurnRuntime {
	const config: NodeRuntimeConfig = { ...NODE_RUNTIME_CONTEXT_DEFAULTS, workspaceRoot: root, homeDir: root,
		provider: "openai", protocol: "responses", model: "fixture", apiBaseUrl: "https://offline.invalid/v1", apiKey: "fixture", authRef: "openai",
		sessionId: "session:error", sessionsDbPath: join(root, "session.db"), maxPromptTokens: 12_000, requestMaxRetries: 1, streamMaxRetries: 1,
		reasoningEffort: "none", thinkingEnabled: false, supportsImages: false, webSearchMode: "disabled", requestPermissionsToolEnabled: false, updatesCheckOnStartup: false,
	};
	return new NodeTurnRuntime({ sessionId: config.sessionId, workspaceRoot: root, threadId: config.sessionId, instructions: "test", store,
		resolveConfig: () => config, createTurnId: () => "turn:error", clock: () => new Date().toISOString(), publishLifecycle: () => {},
		loadLocalImages: () => [],
		createProvider: () => ({ stream: async function* () { yield { type: "text_delta", text: "done" }; yield { type: "completed" }; } }),
		...overrides,
	});
}

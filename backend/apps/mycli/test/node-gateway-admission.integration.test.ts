import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NODE_RUNTIME_CONTEXT_DEFAULTS, type NodeRuntimeConfig } from "@mycli/config";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import { NodeTurnRuntime, SessionGoalService, QueueCoordinator } from "@mycli/runtime";
import { openRuntimeSessionStore } from "@mycli/storage";
import {
	NodeGatewayTurnController,
	type NodeGatewayTurnSettings,
} from "../src/node-runtime/node-gateway-turn-controller.ts";

test("a committed completion wins over Esc during terminal snapshot persistence", async (t) => {
	const snapshot = deferred<void>();
	t.after(() => { snapshot.resolve(); });
	const fixture = await createFixture(t, { writeTerminalSnapshot: () => snapshot.promise });
	const accepted = await fixture.controller.submit(submitParams());
	await waitFor(() => fixture.store.loadTurn("admission-session", "client-1")?.status === "completed");
	const interruption = fixture.controller.interrupt({ turn_id: accepted.turn_id });
	snapshot.resolve();
	assert.equal((await interruption).accepted, false);
	assert.equal(fixture.store.loadTurn("admission-session", "client-1")?.status, "completed");
	assert.equal(fixture.events.filter((event) => event.method === "turn.interrupted").length, 0);
	assert.equal(fixture.events.filter((event) => event.method === "turn.completed").length, 1);
});

test("canceling credential admission settles before readiness and reserves no turn", async (t) => {
	const readiness = deferred<null>();
	const fixture = await createFixture(t, { credentialReadiness: () => readiness.promise });
	const submitting = fixture.controller.submit(submitParams());
	assert.equal(fixture.controller.hasActiveTurn(), true);
	const interrupted = await fixture.controller.interrupt({ turn_id: fixture.controller.activeTurnId() });
	assert.equal(interrupted.accepted, true);
	assert.equal(interrupted.admission_cancelled, true);
	assert.equal((await submitting).accepted, false);
	assert.equal(fixture.controller.hasActiveTurn(), false);
	assert.equal(fixture.store.loadTurn("admission-session", "client-1"), undefined);
	readiness.resolve(null);
	await new Promise<void>((resolve) => { setImmediate(resolve); });
	assert.equal(fixture.providerCalls(), 0);
	assert.equal(fixture.events.length, 0);
});

test("close cancels admission and late readiness cannot start work", async (t) => {
	const readiness = deferred<null>();
	const fixture = await createFixture(t, { credentialReadiness: () => readiness.promise });
	const submitting = fixture.controller.submit(submitParams());
	await fixture.controller.close();
	assert.equal((await submitting).admission_cancelled, true);
	assert.equal(fixture.controller.isAdmissionPending(), false);
	readiness.reject(new Error("late credential failure"));
	await new Promise<void>((resolve) => { setImmediate(resolve); });
	assert.equal(fixture.providerCalls(), 0);
	assert.equal(fixture.store.loadTurn("admission-session", "client-1"), undefined);
	await assert.rejects(() => fixture.controller.submit(submitParams()), /Gateway is closed/u);
});

test("late readiness from canceled admission cannot change the next turn", async (t) => {
	const readiness = deferred<null>();
	let readinessCalls = 0;
	const fixture = await createFixture(t, { credentialReadiness: () => ++readinessCalls === 1
		? readiness.promise : Promise.resolve(null) });
	const first = fixture.controller.submit(submitParams());
	const oldId = fixture.controller.activeTurnId();
	await fixture.controller.interrupt({ turn_id: oldId });
	assert.equal((await first).admission_cancelled, true);
	await fixture.controller.submit({ ...submitParams(), client_turn_id: "client-2", client_user_message_id: "user-2" });
	readiness.resolve(null);
	await waitFor(() => !fixture.controller.hasActiveTurn());
	assert.equal(fixture.providerCalls(), 1);
	assert.equal(fixture.store.loadTurn("admission-session", "client-1"), undefined);
	assert.equal(fixture.store.loadTurn("admission-session", "client-2")?.status, "completed");
});

test("an old client's retried interrupt cannot cancel its successor admission", async (t) => {
	const readiness = deferred<null>();
	const fixture = await createFixture(t, { credentialReadiness: () => readiness.promise });
	const first = fixture.controller.submit(submitParams());
	await fixture.controller.interrupt({ turn_id: fixture.controller.activeTurnId(), client_turn_id: "client-1" });
	await first;
	const next = fixture.controller.submit({ ...submitParams(), client_turn_id: "client-2", client_user_message_id: "user-2" });
	assert.throws(() => fixture.controller.interrupt({
		turn_id: fixture.controller.activeTurnId(), client_turn_id: "client-1",
	}), /active turn changed/u);
	assert.equal(fixture.controller.hasActiveTurn(), true);
	await fixture.controller.close();
	assert.equal((await next).admission_cancelled, true);
	assert.equal(fixture.providerCalls(), 0);
});

test("post-reservation setup and publication failures persist a terminal turn", async (t) => {
	for (const failure of ["configuration", "publication"] as const) {
		await t.test(failure, async (subtest) => {
			const fixture = await createFixture(subtest, {
				...(failure === "publication" ? { failPublication: true } : {}),
			});
			if (failure === "configuration") {
				fixture.runtime.configureRuntimeContext = () => { throw new Error("injected setup failure"); };
			}
			await assert.rejects(() => fixture.controller.submit(submitParams()), /injected/u);
			assert.equal(fixture.store.loadTurn("admission-session", "client-1")?.status, "failed");
			assert.equal(fixture.store.loadTurn("admission-session", "client-1")?.error_code, "config_error");
			assert.equal(fixture.controller.hasActiveTurn(), false);
			assert.equal(fixture.providerCalls(), 0);
			const reopened = openRuntimeSessionStore({ dbPath: fixture.dbPath });
			try {
				assert.equal(reopened.loadTurn("admission-session", "client-1")?.status, "failed");
			} finally {
				reopened.close();
			}
		});
	}
});

test("Esc during reserved failure cleanup cannot report an unreserved admission cancellation", async (t) => {
	const snapshot = deferred<void>();
	t.after(() => { snapshot.resolve(); });
	const fixture = await createFixture(t, { writeTerminalSnapshot: () => snapshot.promise });
	fixture.runtime.configureRuntimeContext = () => { throw new Error("injected setup failure"); };
	const rejected = assert.rejects(() => fixture.controller.submit(submitParams()), /injected/u);
	await waitFor(() => fixture.store.loadTurn("admission-session", "client-1")?.status === "failed");
	const interruption = fixture.controller.interrupt({ turn_id: fixture.controller.activeTurnId() });
	snapshot.resolve();
	const response = await interruption;
	assert.equal(response.accepted, false);
	assert.equal(response.admission_cancelled, undefined);
	await rejected;
	assert.equal(fixture.store.loadTurn("admission-session", "client-1")?.status, "failed");
});

interface Fixture {
	readonly runtime: NodeTurnRuntime;
	readonly goal?: SessionGoalService;
	readonly queue?: QueueCoordinator;
	readonly controller: NodeGatewayTurnController;
	readonly store: ReturnType<typeof openRuntimeSessionStore>;
	readonly dbPath: string;
	readonly events: { readonly method: string; readonly params: Record<string, unknown> }[];
	readonly providerCalls: () => number;
}

async function createFixture(t: test.TestContext, options: {
	readonly credentialReadiness?: NodeGatewayTurnSettings["credentialReadiness"];
	readonly writeTerminalSnapshot?: (turn: RuntimeTurnRecord) => Promise<void>;
	readonly failPublication?: boolean;
	readonly goals?: boolean;
	readonly providerGate?: Promise<void>;
	readonly hasPendingGoalInteraction?: () => boolean;
} = {}): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "mycli-admission-"));
	const dbPath = join(root, "sessions.db");
	const store = openRuntimeSessionStore({ dbPath });
	let calls = 0;
	let id = 0;
	const config: NodeRuntimeConfig = {
		...NODE_RUNTIME_CONTEXT_DEFAULTS,
		workspaceRoot: root, homeDir: root, provider: "openai", protocol: "responses", model: "gpt-test",
		apiBaseUrl: "https://unused.invalid/v1", apiKey: "synthetic-test-key", authRef: "test",
		sessionId: "admission-session", sessionsDbPath: dbPath, maxPromptTokens: 12000,
		requestMaxRetries: 0, streamMaxRetries: 0, reasoningEffort: "none", thinkingEnabled: false,
		supportsImages: false, webSearchMode: "disabled", cacheRetention: "none",
		requestPermissionsToolEnabled: false, updatesCheckOnStartup: false,
	};
	const goal = options.goals ? new SessionGoalService({ sessionId: config.sessionId, threadId: config.sessionId, workspaceRoot: root, store: store.goals }) : undefined;
	const queue = options.goals ? new QueueCoordinator({ initial: { sessionId: config.sessionId, revision: 0, pendingSteers: [], rejectedSteers: [], followUps: [] },
		activeTurnId: null, createQueueId: () => `queue-${++id}`, clock: () => new Date().toISOString(),
		store: { loadCommittedQueueIds: () => new Set(), saveSnapshot: (snapshot) => { store.saveQueueSnapshot({ sessionId: config.sessionId, threadId: config.sessionId, workspaceRoot: root, snapshot }); },
			commitPending: (turnId, records) => store.commitQueuedInputs({ sessionId: config.sessionId, turnId, records }) } }) : undefined;
	const runtime = new NodeTurnRuntime({
		goal, queueCoordinator: queue,
		sessionId: config.sessionId, threadId: config.sessionId, workspaceRoot: root, store,
		instructions: "Offline regression.", resolveConfig: () => config,
		createProvider: () => ({ stream: async function* (_request, input) {
			calls += 1;
			if (options.providerGate) await Promise.race([options.providerGate, new Promise<void>((resolve) => {
				if (input.signal.aborted) resolve(); else input.signal.addEventListener("abort", () => resolve(), { once: true });
			})]);
			yield { type: "text_delta", text: "Completed output." };
			yield { type: "completed", responseId: "synthetic-response" };
		} }),
		loadLocalImages: () => [], createTurnId: () => `turn-${++id}`,
		clock: () => new Date().toISOString(), publishLifecycle: () => undefined,
		...(options.writeTerminalSnapshot ? { writeTerminalSnapshot: options.writeTerminalSnapshot } : {}),
	});
	if (goal) Object.assign(runtime, { goal });
	const context = { sessionId: config.sessionId, generation: 1 };
	const events: Fixture["events"] = [];
	const controller: NodeGatewayTurnController = new NodeGatewayTurnController({
		dependencies: { createTurnId: () => `turn-${++id}`, hasPendingGoalInteraction: options.hasPendingGoalInteraction },
		session: {
			transitionActive: false, controlActive: false, sessionId: () => context.sessionId,
			context: () => context, isCurrent: (candidate) => candidate === context,
			runtime: () => runtime, queueCoordinator: () => queue,
			requiredQueueCoordinator: () => { throw new Error("No queue in fixture"); },
			assertMutationContext: () => context,
		},
		settings: {
			model: "gpt-test", reasoningEffort: undefined, collaborationMode: "default",
			credentialReadiness: options.credentialReadiness ?? (async () => null),
			ensureSessionPreferences: () => undefined, setCollaborationMode: () => undefined,
			modeForTurn: () => "default", rememberTurnMode: () => undefined, forgetTurnMode: () => undefined,
		},
		isClosed: () => false,
		status: () => ({ turn_running: controller.hasActiveTurn(), turn_id: controller.activeTurnId() }),
		publish: (method, params) => {
			if (options.failPublication) throw new Error("injected publication failure");
			events.push({ method, params });
		},
	});
	t.after(async () => {
		await controller.close();
		store.close();
		await rm(root, { recursive: true, force: true });
	});
	return { runtime, controller, goal, queue, store, dbPath, events, providerCalls: () => calls };
}

function submitParams(): Record<string, unknown> {
	return { message: "Test instruction.", client_turn_id: "client-1", client_user_message_id: "user-1" };
}

function deferred<Value>(): { readonly promise: Promise<Value>; readonly resolve: (value: Value) => void; readonly reject: (error: Error) => void } {
	let resolve!: (value: Value) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<Value>((settle, fail) => { resolve = settle; reject = fail; });
	return { promise, resolve, reject };
}

async function waitFor(read: () => boolean): Promise<void> {
	const deadline = performance.now() + 2000;
	while (!read()) {
		if (performance.now() >= deadline) throw new Error("state wait timed out");
		await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
	}
}

test("duplicate goal idle notifications reserve one ordinary turn", async (t) => {
	const gate = deferred<void>();
	const f = await createFixture(t, { goals: true, providerGate: gate.promise });
	f.goal!.create({ objective: "Finish" });
	f.controller.requestNextQueuedTurn(); f.controller.requestNextQueuedTurn();
	await waitFor(() => f.providerCalls() === 1);
	assert.equal(f.goal!.get()?.rounds_started, 1);
	f.goal!.interrupt(); gate.resolve();
	await waitFor(() => !f.controller.hasActiveTurn());
	assert.equal(f.providerCalls(), 1);
});

test("pause before queued goal admission prevents any provider work", async (t) => {
	const f = await createFixture(t, { goals: true });
	f.goal!.create({ objective: "Finish" });
	f.controller.requestNextQueuedTurn();
	f.goal!.interrupt();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(f.providerCalls(), 0);
	assert.equal(f.goal!.get()?.rounds_started, 0);
});

test("goal persistence failure cannot prevent interruption or retain turn execution state", async (t) => {
	const gate = deferred<void>();
	const f = await createFixture(t, { goals: true, providerGate: gate.promise });
	f.goal!.create({ objective: "Finish" });
	const accepted = await f.controller.submit(submitParams());
	await waitFor(() => f.providerCalls() === 1);
	const commit = f.store.goals.commit.bind(f.store.goals);
	f.store.goals.commit = () => { throw new Error("injected goal persistence failure"); };
	try {
		await assert.rejects(async () => f.controller.interrupt({ turn_id: accepted.turn_id }), /goal persistence failure/);
		await waitFor(() => !f.controller.hasActiveTurn());
		assert.equal(f.store.loadTurn("admission-session", "client-1")?.status, "interrupted");
		assert.equal(f.runtime.runExecutionSnapshot(String(accepted.turn_id)), undefined);
		assert.equal(f.goal!.continuation(), undefined);
		assert.match(f.goal!.executionHaltReason()!, /runtime stopped/);
	} finally { f.store.goals.commit = commit; gate.resolve(); }
});

test("a queued human input wins over automatic continuation", async (t) => {
	const gate = deferred<void>();
	const f = await createFixture(t, { goals: true, providerGate: gate.promise });
	f.goal!.create({ objective: "Finish" });
	f.queue!.enqueueFollowUp({ clientTurnId: "human-priority", text: "Inspect this first" });
	f.controller.requestNextQueuedTurn();
	await waitFor(() => f.providerCalls() === 1);
	assert.ok(f.store.loadTurn("admission-session", "human-priority"));
	assert.equal(f.goal!.get()?.rounds_started, 0);
	f.goal!.interrupt(); gate.resolve();
	await waitFor(() => !f.controller.hasActiveTurn());
});

test("pending interactive requests defer goal admission until resolved", async (t) => {
	let pending = true;
	const gate = deferred<void>();
	const f = await createFixture(t, { goals: true, providerGate: gate.promise, hasPendingGoalInteraction: () => pending });
	f.goal!.create({ objective: "Finish" });
	f.controller.requestNextQueuedTurn();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(f.providerCalls(), 0);
	pending = false; f.controller.requestNextQueuedTurn();
	await waitFor(() => f.providerCalls() === 1);
	f.goal!.interrupt(); gate.resolve();
	await waitFor(() => !f.controller.hasActiveTurn());
});

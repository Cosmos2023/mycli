import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import {
	SessionCoordinator,
	type PreparedSession,
	type SessionGenerationContext,
} from "@mycli/runtime";
import type { TurnReservation } from "@mycli/storage";
import {
	NodeGatewayTurnController,
	type NodeGatewayTurnDependencies,
	type NodeGatewayTurnSession,
	type NodeGatewayTurnSettings,
} from "../src/node-runtime/node-gateway-turn-controller.ts";
import type { NodeGatewayRuntime } from "../src/node-runtime/node-gateway-types.ts";

type JsonObject = Record<string, unknown>;

interface PublishedEvent {
	readonly method: string;
	readonly params: JsonObject;
}

interface ControlledRun {
	readonly signal: AbortSignal;
	readonly emit: Parameters<NodeGatewayRuntime["submit"]>[1];
	readonly resolve: (record: RuntimeTurnRecord) => void;
}

test("turn admission releases its exact execution claim after pre-activation failures", async (t) => {
	await t.test("credential readiness", async () => {
		const readiness = deferred<null>();
		const fixture = controllerFixture({ credentialReadiness: () => readiness.promise });
		const submission = fixture.controller.submit(submitParams("client-auth"));

		assert.equal(fixture.controller.isAdmissionPending(), true);
		assert.equal(fixture.coordinator.executing(), true);
		readiness.reject(new Error("credential lookup failed"));
		await assert.rejects(submission, /credential lookup failed/u);
		assertAdmissionReleased(fixture);
	});

	await t.test("turn reservation", async () => {
		const fixture = controllerFixture({
			reserve: () => { throw new Error("reservation failed"); },
		});

		await assert.rejects(
			() => fixture.controller.submit(submitParams("client-reserve")),
			/reservation failed/u,
		);
		assertAdmissionReleased(fixture);
	});

	await t.test("runtime configuration", async () => {
		const fixture = controllerFixture({
			configureRuntimeContext: () => { throw new Error("configuration failed"); },
		});

		await assert.rejects(
			() => fixture.controller.submit(submitParams("client-configure")),
			/configuration failed/u,
		);
		assertAdmissionReleased(fixture);
	});
});

test("turn controller rejects runtime events captured by an older session generation", async () => {
	let context: SessionGenerationContext = Object.freeze({ sessionId: "source", generation: 1 });
	const controlled = controlledRuntime();
	const events: PublishedEvent[] = [];
	const session = sessionStub(controlled.runtime, () => context);
	const controller = new NodeGatewayTurnController({
		dependencies: { createTurnId: () => "turn-source" },
		session,
		settings: settingsStub(),
		isClosed: () => false,
		status: () => ({}),
		publish: (method, params) => { events.push({ method, params }); },
	});

	await controller.submit(submitParams("client-source"));
	const run = await waitForRun(controlled.runs);
	context = Object.freeze({ sessionId: "target", generation: 2 });
	run.emit({ type: "text_delta", text: "stale output" });
	assert.equal(events.some((event) => event.method === "message.delta"), false);

	run.resolve(completedTurn("source", "client-source", "turn-source"));
	await waitFor(() => !controller.hasActiveTurn());
	assert.equal(events.some((event) => event.method === "turn.completed"), false);
});

test("a late callback from a completed turn cannot clear or project into its successor", async () => {
	const fixture = controllerFixture();
	await fixture.controller.submit(submitParams("client-first"));
	const first = await waitForRun(fixture.runs, 0);
	first.resolve(completedTurn("session-a", "client-first", "turn-1"));
	await waitFor(() => !fixture.controller.hasActiveTurn());

	await fixture.controller.submit(submitParams("client-second"));
	const second = await waitForRun(fixture.runs, 1);
	const completedBeforeLateEvent = eventCount(fixture.events, "turn.completed");
	first.emit({
		type: "turn_completed",
		assistantText: "late first result",
		usage: {},
	});

	assert.equal(fixture.controller.activeTurnId(), "turn-2");
	assert.equal(fixture.coordinator.executing(), true);
	assert.equal(eventCount(fixture.events, "turn.completed"), completedBeforeLateEvent);

	second.resolve(completedTurn("session-a", "client-second", "turn-2"));
	await waitFor(() => !fixture.controller.hasActiveTurn());
	assert.equal(fixture.coordinator.executing(), false);
});

test("close aborts the active turn and remains pending until its task settles", async () => {
	let closed = false;
	const fixture = controllerFixture({ isClosed: () => closed });
	await fixture.controller.submit(submitParams("client-close"));
	const run = await waitForRun(fixture.runs);
	let closeSettled = false;
	closed = true;
	const closing = fixture.controller.close().then(() => { closeSettled = true; });

	assert.equal(run.signal.aborted, true);
	await new Promise<void>((resolve) => { setImmediate(resolve); });
	assert.equal(closeSettled, false);

	run.resolve(interruptedTurn("session-a", "client-close", "turn-1"));
	await closing;
	assert.equal(fixture.coordinator.executing(), false);
});

test("ownership resolution prefers explicit turn ids and matches active client turns", async () => {
	const fixture = controllerFixture();
	assert.deepEqual(fixture.controller.currentOwnership({}), {
		sessionId: "session-a",
		generation: 1,
	});
	assert.deepEqual(fixture.controller.currentOwnership({ turn_id: "turn-explicit" }), {
		sessionId: "session-a",
		generation: 1,
		turnId: "turn-explicit",
	});

	await fixture.controller.submit(submitParams("client-owned"));
	const run = await waitForRun(fixture.runs);
	assert.deepEqual(fixture.controller.currentOwnership({ client_turn_id: "client-owned" }), {
		sessionId: "session-a",
		generation: 1,
		turnId: "turn-1",
	});
	assert.deepEqual(fixture.controller.currentOwnership({ client_turn_id: "another-turn" }), {
		sessionId: "session-a",
		generation: 1,
	});

	run.resolve(completedTurn("session-a", "client-owned", "turn-1"));
	await waitFor(() => !fixture.controller.hasActiveTurn());
});

function controllerFixture(options: {
	readonly credentialReadiness?: NodeGatewayTurnSettings["credentialReadiness"];
	readonly reserve?: NodeGatewayRuntime["reserve"];
	readonly configureRuntimeContext?: NonNullable<NodeGatewayRuntime["configureRuntimeContext"]>;
	readonly isClosed?: () => boolean;
} = {}): {
	readonly controller: NodeGatewayTurnController;
	readonly coordinator: SessionCoordinator<NodeGatewayRuntime>;
	readonly events: PublishedEvent[];
	readonly runs: ControlledRun[];
} {
	let turnSequence = 0;
	const controlled = controlledRuntime({
		...(options.reserve ? { reserve: options.reserve } : {}),
		...(options.configureRuntimeContext
			? { configureRuntimeContext: options.configureRuntimeContext }
			: {}),
	});
	const coordinator = new SessionCoordinator<NodeGatewayRuntime>({
		initial: preparedSession(controlled.runtime),
		prepare: () => { throw new Error("session preparation is not used by this test"); },
		listSessions: () => [],
		loadSessionLineage: (sessionId) => [{ sessionId }],
	});
	const events: PublishedEvent[] = [];
	const dependencies: NodeGatewayTurnDependencies = {
		sessionCoordinator: coordinator,
		createTurnId: () => `turn-${++turnSequence}`,
	};
	const controller = new NodeGatewayTurnController({
		dependencies,
		session: sessionStub(controlled.runtime, () => coordinator.context(), coordinator),
		settings: settingsStub(options.credentialReadiness),
		isClosed: options.isClosed ?? (() => false),
		status: () => ({ state: "idle" }),
		publish: (method, params) => { events.push({ method, params }); },
	});
	return { controller, coordinator, events, runs: controlled.runs };
}

function controlledRuntime(options: {
	readonly reserve?: NodeGatewayRuntime["reserve"];
	readonly configureRuntimeContext?: NonNullable<NodeGatewayRuntime["configureRuntimeContext"]>;
} = {}): { readonly runtime: NodeGatewayRuntime; readonly runs: ControlledRun[] } {
	const runs: ControlledRun[] = [];
	const runtime: NodeGatewayRuntime = {
		...(options.configureRuntimeContext
			? { configureRuntimeContext: options.configureRuntimeContext }
			: {}),
		reserve: options.reserve ?? ((submission) => reservation(
			"session-a",
			submission.clientTurnId,
			submission.turnId ?? "turn-missing",
		)),
		resolveApproval: async () => { throw new Error("approval is not used by this test"); },
		resolveClarification: async () => { throw new Error("clarification is not used by this test"); },
		submit: (_submission, emit, submitOptions) => {
			const result = deferred<RuntimeTurnRecord>();
			runs.push({ signal: submitOptions.signal, emit, resolve: result.resolve });
			return result.promise;
		},
		forceInterrupt: async (input) => interruptedTurn("session-a", input.clientTurnId, input.turnId),
	};
	return { runtime, runs };
}

function sessionStub(
	runtime: NodeGatewayRuntime,
	context: () => SessionGenerationContext,
	coordinator?: SessionCoordinator<NodeGatewayRuntime>,
): NodeGatewayTurnSession {
	return {
		transitionActive: false,
		controlActive: false,
		sessionId: () => context().sessionId,
		context,
		isCurrent: (candidate) => coordinator?.isCurrent(candidate) ?? (
			candidate.sessionId === context().sessionId
			&& candidate.generation === context().generation
		),
		runtime: () => runtime,
		queueCoordinator: () => undefined,
		requiredQueueCoordinator: () => { throw new Error("queue is not used by this test"); },
		assertMutationContext: () => context(),
	};
}

function settingsStub(
	credentialReadiness: NodeGatewayTurnSettings["credentialReadiness"] = async () => null,
): NodeGatewayTurnSettings {
	let collaborationMode: "default" | "plan" = "default";
	const turnModes = new Map<string, "default" | "plan">();
	return {
		model: "gpt-test",
		reasoningEffort: undefined,
		get collaborationMode() { return collaborationMode; },
		credentialReadiness,
		ensureSessionPreferences: () => {},
		setCollaborationMode: (mode) => { collaborationMode = mode; },
		modeForTurn: (turnId) => turnModes.get(turnId) ?? collaborationMode,
		rememberTurnMode: (turnId, mode) => { turnModes.set(turnId, mode); },
		forgetTurnMode: (turnId) => { turnModes.delete(turnId); },
	};
}

function preparedSession(runtime: NodeGatewayRuntime): PreparedSession<NodeGatewayRuntime> {
	return {
		sessionId: "session-a",
		workspaceRoot: "/repo",
		threadId: "session-a",
		transcript: [],
		queue: {
			sessionId: "session-a",
			revision: 0,
			pendingSteers: [],
			rejectedSteers: [],
			followUps: [],
		},
		suspendedTurn: false,
		readOnly: false,
		binding: runtime,
	};
}

function submitParams(clientTurnId: string): JsonObject {
	return {
		message: "test message",
		client_turn_id: clientTurnId,
		client_user_message_id: `${clientTurnId}-message`,
		local_images: [],
	};
}

function reservation(sessionId: string, clientTurnId: string, turnId: string): TurnReservation {
	return { kind: "reserved", turn: inProgressTurn(sessionId, clientTurnId, turnId) };
}

function inProgressTurn(
	sessionId: string,
	clientTurnId: string,
	turnId: string,
): RuntimeTurnRecord {
	return {
		schema_version: 1,
		session_id: sessionId,
		client_turn_id: clientTurnId,
		turn_id: turnId,
		request_fingerprint: `fingerprint:${clientTurnId}`,
		status: "in_progress",
		error_code: null,
		result: null,
		started_at: "2026-09-04T00:00:00.000Z",
		completed_at: null,
	};
}

function completedTurn(
	sessionId: string,
	clientTurnId: string,
	turnId: string,
): RuntimeTurnRecord {
	return {
		...inProgressTurn(sessionId, clientTurnId, turnId),
		status: "completed",
		result: { assistant_text: "done", usage: {} },
		completed_at: "2026-09-04T00:00:01.000Z",
	};
}

function interruptedTurn(
	sessionId: string,
	clientTurnId: string,
	turnId: string,
): RuntimeTurnRecord {
	return {
		...inProgressTurn(sessionId, clientTurnId, turnId),
		status: "interrupted",
		error_code: "interrupted",
		result: { message: "Turn interrupted." },
		completed_at: "2026-09-04T00:00:01.000Z",
	};
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function waitForRun(runs: readonly ControlledRun[], index = 0): Promise<ControlledRun> {
	return waitFor(() => runs[index]);
}

async function waitFor<T>(read: () => T | false | undefined): Promise<T> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const value = read();
		if (value) return value;
		await new Promise<void>((resolve) => { setImmediate(resolve); });
	}
	throw new Error("timed out waiting for turn controller state");
}

function assertAdmissionReleased(fixture: {
	readonly controller: NodeGatewayTurnController;
	readonly coordinator: SessionCoordinator<NodeGatewayRuntime>;
}): void {
	assert.equal(fixture.controller.isAdmissionPending(), false);
	assert.equal(fixture.controller.hasActiveTurn(), false);
	assert.equal(fixture.coordinator.executing(), false);
}

function eventCount(events: readonly PublishedEvent[], method: string): number {
	return events.filter((event) => event.method === method).length;
}

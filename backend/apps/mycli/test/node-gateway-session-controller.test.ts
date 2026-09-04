import assert from "node:assert/strict";
import test from "node:test";
import type { QueueSnapshot } from "@mycli/core";
import {
	QueueCoordinator,
	SessionCoordinator,
	type PreparedSession,
	type QueueCoordinatorStore,
} from "@mycli/runtime";
import type { NodeGatewayRuntime } from "../src/node-runtime/node-gateway-types.ts";
import { NodeGatewaySessionController } from "../src/node-runtime/node-gateway-session-controller.ts";

type JsonObject = Record<string, unknown>;

test("session controller keeps transitions and control claims mutually exclusive", async () => {
	let markPreparationStarted!: () => void;
	let releasePreparation!: () => void;
	const preparationStarted = new Promise<void>((resolve) => { markPreparationStarted = resolve; });
	const preparationReleased = new Promise<void>((resolve) => { releasePreparation = resolve; });
	const coordinator = new SessionCoordinator<NodeGatewayRuntime>({
		initial: preparedSession("source"),
		prepare: async (sessionId) => {
			markPreparationStarted();
			await preparationReleased;
			return preparedSession(sessionId);
		},
		listSessions: () => [],
		loadSessionLineage: (sessionId) => [{ sessionId }],
	});
	const { controller } = controllerFixture(coordinator);

	const resume = controller.resume({ session_id: "target" });
	await preparationStarted;
	assert.equal(controller.transitionActive, true);
	assert.throws(
		() => controller.claimControl("Session control is busy."),
		(error: unknown) => gatewayCode(error) === "turn_in_progress",
	);
	releasePreparation();
	await resume;
	assert.equal(controller.transitionActive, false);

	const releaseFirst = controller.claimControl("Session control is busy.");
	assert.equal(controller.controlActive, true);
	releaseFirst();
	assert.equal(controller.controlActive, false);
	const releaseSecond = controller.claimControl("Session control is busy.");
	releaseFirst();
	assert.equal(controller.controlActive, true);
	releaseSecond();
	releaseSecond();
	assert.equal(controller.controlActive, false);
});

test("failed resume releases session admission for later work", async () => {
	const coordinator = new SessionCoordinator<NodeGatewayRuntime>({
		initial: preparedSession("source"),
		prepare: () => { throw new Error("target unavailable"); },
		listSessions: () => [],
		loadSessionLineage: (sessionId) => [{ sessionId }],
	});
	const { controller } = controllerFixture(coordinator);

	await assert.rejects(() => controller.resume({ session_id: "target" }), /target unavailable/u);
	assert.equal(controller.transitionActive, false);
	const release = controller.claimControl("Session control is busy.");
	assert.equal(controller.controlActive, true);
	release();
	assert.equal(controller.controlActive, false);
});

test("queue projection rejects callbacks captured by an older session generation", async () => {
	const sourceQueue = queueCoordinator("source");
	const targetQueue = queueCoordinator("target");
	const sourceListeners: Array<(snapshot: QueueSnapshot) => void> = [];
	const targetListeners: Array<(snapshot: QueueSnapshot) => void> = [];
	captureQueueListeners(sourceQueue, sourceListeners);
	captureQueueListeners(targetQueue, targetListeners);
	const coordinator = new SessionCoordinator<NodeGatewayRuntime>({
		initial: preparedSession("source", sourceQueue),
		prepare: (sessionId) => preparedSession(sessionId, targetQueue),
		listSessions: () => [],
		loadSessionLineage: (sessionId) => [{ sessionId }],
	});
	const { controller, runtimeEvents } = controllerFixture(coordinator);
	controller.bindQueue();
	assert.equal(sourceListeners.length, 1);

	sourceListeners[0]?.(emptyQueue("source", 1));
	assert.deepEqual(queueEvents(runtimeEvents), [{
		method: "turn.queue.updated",
		params: { session_id: "source", generation: 1, revision: 1 },
	}]);

	await controller.resume({ session_id: "target" });
	assert.equal(targetListeners.length, 1);
	sourceListeners[0]?.(emptyQueue("source", 2));
	assert.equal(queueEvents(runtimeEvents).length, 1);
	targetListeners[0]?.(emptyQueue("target", 1));
	assert.deepEqual(queueEvents(runtimeEvents).at(-1), {
		method: "turn.queue.updated",
		params: { session_id: "target", generation: 2, revision: 1 },
	});
});

function controllerFixture(coordinator: SessionCoordinator<NodeGatewayRuntime>): {
	readonly controller: NodeGatewaySessionController;
	readonly runtimeEvents: Array<{ readonly method: string; readonly params: JsonObject }>;
} {
	const runtimeEvents: Array<{ readonly method: string; readonly params: JsonObject }> = [];
	const controller = new NodeGatewaySessionController({
		initialSessionId: coordinator.snapshot().sessionId,
		initialWorkspaceRoot: coordinator.snapshot().workspaceRoot,
		initialRuntime: coordinator.snapshot().binding,
		coordinator,
		isClosed: () => false,
		hasActiveTurn: () => false,
		isTurnAdmissionPending: () => false,
		hasPendingInteractiveRequest: () => false,
		hasPendingAgentRequest: () => false,
		activateSettings: async () => {},
		activeShellPayloads: () => [],
		authProviders: async () => [],
		credentialReadiness: async () => null,
		status: () => ({}),
		queuePayload: (snapshot, context) => ({
			session_id: snapshot.sessionId,
			generation: context.generation,
			revision: snapshot.revision,
		}),
		publish: (method, params) => { runtimeEvents.push({ method, params }); },
		publishDirect: () => {},
		requestNextQueuedTurn: () => {},
	});
	return { controller, runtimeEvents };
}

function preparedSession(
	sessionId: string,
	queue = queueCoordinator(sessionId),
): PreparedSession<NodeGatewayRuntime> {
	return {
		sessionId,
		workspaceRoot: "/repo",
		threadId: sessionId,
		transcript: [],
		queue: queue.snapshot(),
		suspendedTurn: false,
		readOnly: false,
		binding: runtime(queue),
	};
}

function runtime(queue: QueueCoordinator): NodeGatewayRuntime {
	const unavailable = (): never => { throw new Error("runtime method is not used by this test"); };
	return {
		queueCoordinator: queue,
		reserve: unavailable,
		resolveApproval: unavailable,
		resolveClarification: unavailable,
		submit: unavailable,
		forceInterrupt: unavailable,
	};
}

function queueCoordinator(sessionId: string): QueueCoordinator {
	let snapshot = emptyQueue(sessionId);
	const store: QueueCoordinatorStore = {
		loadCommittedQueueIds: () => new Set(),
		saveSnapshot: (next) => { snapshot = next; },
		commitPending: () => snapshot,
	};
	return new QueueCoordinator({
		initial: snapshot,
		store,
		activeTurnId: null,
		createQueueId: () => "queue-id",
		clock: () => "2026-09-04T00:00:00.000Z",
	});
}

function captureQueueListeners(
	queue: QueueCoordinator,
	listeners: Array<(snapshot: QueueSnapshot) => void>,
): void {
	Object.defineProperty(queue, "subscribe", {
		configurable: true,
		value: (listener: (snapshot: QueueSnapshot) => void) => {
			listeners.push(listener);
			return () => {};
		},
	});
}

function emptyQueue(sessionId: string, revision = 0): QueueSnapshot {
	return Object.freeze({
		sessionId,
		revision,
		pendingSteers: Object.freeze([]),
		rejectedSteers: Object.freeze([]),
		followUps: Object.freeze([]),
	});
}

function queueEvents(
	events: readonly { readonly method: string; readonly params: JsonObject }[],
): readonly { readonly method: string; readonly params: JsonObject }[] {
	return events.filter((event) => event.method === "turn.queue.updated");
}

function gatewayCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error
		? error.code
		: undefined;
}

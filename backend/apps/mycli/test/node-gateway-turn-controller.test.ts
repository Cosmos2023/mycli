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

test("terminal interaction metadata reaches start and completion with bounded previews", async () => {
	const fixture = controllerFixture();
	await fixture.controller.submit(submitParams("client-terminal"));
	const run = await waitForRun(fixture.runs);
	const interaction = { shell_id: "shell-1", kind: "input" as const, input_preview: '"token=private-input"' };
	run.emit({ type: "tool_execution_started", callId: "input-1", toolName: "WriteStdin", terminalInteraction: interaction });
	const start = fixture.events.find((event) => event.method === "tool.start");
	assert.equal((start?.params.terminal_interaction as JsonObject).shell_id, "shell-1");
	assert.doesNotMatch(JSON.stringify(start), /private-input/u);
	run.emit({ type: "tool_execution_completed", callId: "input-1", toolName: "WriteStdin", summary: "Shell is running", durationMs: 10,
		metadata: { terminal_interaction: { ...interaction, process_running: true, interaction_succeeded: true }, raw_stdin: "private-input" } });
	const finish = fixture.events.find((event) => event.method === "tool.complete");
	assert.equal((finish?.params.terminal_interaction as JsonObject).interaction_succeeded, true);
	assert.doesNotMatch(JSON.stringify(finish), /private-input|raw_stdin/u);
	run.resolve(completedTurn("session-a", "client-terminal", "turn-1"));
	await waitFor(() => !fixture.controller.hasActiveTurn());
});

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

test("interrupt acknowledgment waits for cleanup even after a terminal event was published", async () => {
	const fixture = controllerFixture();
	await fixture.controller.submit(submitParams("client-first"));
	const first = await waitForRun(fixture.runs);
	first.emit({ type: "turn_interrupted", message: "turn interrupted" });
	assert.equal(fixture.controller.hasActiveTurn(), true);

	const result = await fixture.controller.interrupt({ turn_id: "turn-1" });
	assert.equal(result.accepted, true);
	assert.equal(fixture.controller.hasActiveTurn(), false);
	assert.equal(fixture.coordinator.executing(), false);
	assert.equal(eventCount(fixture.events, "turn.interrupted"), 1);

	await fixture.controller.submit(submitParams("client-second"));
	const second = await waitForRun(fixture.runs, 1);
	first.resolve(interruptedTurn("session-a", "client-first", "turn-1"));
	await new Promise<void>((resolve) => { setImmediate(resolve); });
	assert.equal(fixture.controller.activeTurnId(), "turn-2");
	assert.equal(fixture.coordinator.executing(), true);
	second.resolve(completedTurn("session-a", "client-second", "turn-2"));
	await waitFor(() => !fixture.controller.hasActiveTurn());
});

test("approval publication waits for suspension and accepts an immediate response", async () => {
	let readyAtPublication = false;
	let executions = 0;
	const fixture = controllerFixture({
		onPublish: (event) => {
			if (event.method === "approval.request") {
				readyAtPublication = !fixture.controller.hasActiveTurn() && !fixture.coordinator.executing();
			}
		},
		resolveApproval: async () => {
			executions += 1;
			return completedTurn("session-a", "client-approval", "turn-1");
		},
	});
	await fixture.controller.submit(submitParams("client-approval"));
	const run = await waitForRun(fixture.runs);
	run.emit({
		type: "approval_requested", clientTurnId: "client-approval", turnId: "turn-1",
		decisionId: "call-shell", callId: "call-shell", toolName: "Shell",
		preview: "run command", reason: "approval required", options: ["approve_once", "reject"],
		commandPreview: "npm run build --workspace app\n  npm test", commandTruncated: false,
		justification: "Build the app and run its tests.",
	});
	assert.equal(eventCount(fixture.events, "approval.request"), 0);
	assert.equal(fixture.coordinator.executing(), true);
	run.resolve(inProgressTurn("session-a", "client-approval", "turn-1"));
	await waitFor(() => eventCount(fixture.events, "approval.request") === 1);
	assert.equal(readyAtPublication, true);
	assert.equal(fixture.events.find((event) => event.method === "approval.request")?.params.command_preview,
		"npm run build --workspace app\n  npm test");
	assert.equal(fixture.events.find((event) => event.method === "approval.request")?.params.command_truncated, false);
	assert.equal(fixture.events.find((event) => event.method === "approval.request")?.params.justification,
		"Build the app and run its tests.");
	const response = fixture.controller.respondApproval({ decision_id: "call-shell", choice: "approve_once" });
	assert.equal(response.accepted, true);
	assert.throws(
		() => fixture.controller.respondApproval({ decision_id: "call-shell", choice: "approve_once" }),
		{ code: "approval_not_pending" },
	);
	await waitFor(() => !fixture.controller.hasActiveTurn());
	assert.equal(executions, 1);
	assert.equal(eventCount(fixture.events, "approval.request"), 1);
});

test("live approvals advance on the active turn without releasing ownership or starting a continuation", async () => {
	const decisions: string[] = [];
	const fixture = controllerFixture({
		hasActiveApproval: (decisionId) => !decisions.includes(decisionId),
		respondActiveApproval: (input) => { decisions.push(input.decisionId); },
		resolveApproval: async () => { assert.fail("live approval must not start a continuation"); },
	});
	await fixture.controller.submit(submitParams("client-live"));
	const run = await waitForRun(fixture.runs);
	for (const decisionId of ["call-first", "call-second"]) {
		run.emit({
			type: "approval_requested", clientTurnId: "client-live", turnId: "turn-1",
			decisionId, callId: decisionId, toolName: "Shell", preview: decisionId,
			reason: "approval required", options: ["approve_once", "reject"],
			commandPreview: `echo ${decisionId}`, commandTruncated: false,
			justification: `Verify ${decisionId}.`,
		});
		assert.equal(fixture.coordinator.snapshot().pendingApproval?.decisionId, decisionId);
		assert.equal(fixture.coordinator.snapshot().pendingApproval?.commandPreview, `echo ${decisionId}`);
		assert.equal(fixture.coordinator.snapshot().pendingApproval?.justification, `Verify ${decisionId}.`);
		assert.equal(fixture.events.filter((event) => event.method === "approval.request").at(-1)?.params.command_preview,
			`echo ${decisionId}`);
		assert.equal(fixture.events.filter((event) => event.method === "approval.request").at(-1)?.params.justification,
			`Verify ${decisionId}.`);
		assert.equal(fixture.controller.hasActiveTurn(), true);
		for (const stale of [{ generation: 2 }, { session_id: "different-session" }]) {
			assert.throws(() => fixture.controller.respondApproval({
				decision_id: decisionId, choice: "approve_once", ...stale,
			}), { code: "approval_not_pending" });
		}
		assert.equal(fixture.controller.respondApproval({
			decision_id: decisionId, choice: "approve_once", session_id: "session-a", generation: 1,
		}).accepted, true);
		assert.equal(fixture.coordinator.executing(), true);
		assert.equal(fixture.controller.activeTurnId(), "turn-1");
		assert.equal(fixture.runs.length, 1);
		assert.throws(() => fixture.controller.respondApproval({
			decision_id: decisionId, choice: "approve_once",
		}), { code: "approval_not_pending" });
	}
	assert.deepEqual(decisions, ["call-first", "call-second"]);
	run.resolve(completedTurn("session-a", "client-live", "turn-1"));
	await waitFor(() => !fixture.controller.hasActiveTurn());
	assert.equal(fixture.coordinator.executing(), false);
	assert.equal(eventCount(fixture.events, "approval.request"), 2);
});

test("an approval staged during suspension is not published after cancellation", async () => {
	const fixture = controllerFixture();
	await fixture.controller.submit(submitParams("client-cancel"));
	const run = await waitForRun(fixture.runs);
	run.emit({
		type: "approval_requested", clientTurnId: "client-cancel", turnId: "turn-1",
		decisionId: "call-shell", callId: "call-shell", toolName: "Shell",
		preview: "run command", reason: "approval required", options: ["approve_once", "reject"],
	});
	const closing = fixture.controller.close();
	run.resolve(interruptedTurn("session-a", "client-cancel", "turn-1"));
	await closing;
	assert.equal(eventCount(fixture.events, "approval.request"), 0);
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
	readonly resolveApproval?: NodeGatewayRuntime["resolveApproval"];
	readonly hasActiveApproval?: NodeGatewayRuntime["hasActiveApproval"];
	readonly respondActiveApproval?: NodeGatewayRuntime["respondActiveApproval"];
	readonly onPublish?: (event: PublishedEvent) => void;
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
		...(options.resolveApproval ? { resolveApproval: options.resolveApproval } : {}),
		...(options.hasActiveApproval ? { hasActiveApproval: options.hasActiveApproval } : {}),
		...(options.respondActiveApproval ? { respondActiveApproval: options.respondActiveApproval } : {}),
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
		publish: (method, params) => {
			events.push({ method, params });
			options.onPublish?.({ method, params });
		},
	});
	return { controller, coordinator, events, runs: controlled.runs };
}

function controlledRuntime(options: {
	readonly reserve?: NodeGatewayRuntime["reserve"];
	readonly configureRuntimeContext?: NonNullable<NodeGatewayRuntime["configureRuntimeContext"]>;
	readonly resolveApproval?: NodeGatewayRuntime["resolveApproval"];
	readonly hasActiveApproval?: NodeGatewayRuntime["hasActiveApproval"];
	readonly respondActiveApproval?: NodeGatewayRuntime["respondActiveApproval"];
} = {}): { readonly runtime: NodeGatewayRuntime; readonly runs: ControlledRun[] } {
	const runs: ControlledRun[] = [];
	const runtime: NodeGatewayRuntime = {
		...(options.hasActiveApproval ? { hasActiveApproval: options.hasActiveApproval } : {}),
		...(options.respondActiveApproval ? { respondActiveApproval: options.respondActiveApproval } : {}),
		...(options.configureRuntimeContext
			? { configureRuntimeContext: options.configureRuntimeContext }
			: {}),
		reserve: options.reserve ?? ((submission) => reservation(
			"session-a",
			submission.clientTurnId,
			submission.turnId ?? "turn-missing",
		)),
		resolveApproval: options.resolveApproval ?? (async () => { throw new Error("approval is not used by this test"); }),
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

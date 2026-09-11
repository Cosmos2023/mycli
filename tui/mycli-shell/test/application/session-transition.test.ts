import assert from "node:assert/strict";
import test from "node:test";
import { SessionTransitionController } from "../../src/application/session-transition.ts";
import { initialRuntimeState, type RuntimeShellState } from "../../src/state/runtime-state-model.ts";
import { reduceRuntimeEvent } from "../../src/state/runtime-event-reducer.ts";

function sourceState(): RuntimeShellState {
	return {
		...initialRuntimeState(), sessionId: "source", sessionGeneration: 1,
		transcript: [{ id: "source-message", type: "user", text: "source history" }],
	};
}

function page(sessionId: string): Record<string, unknown> {
	return {
		session_id: sessionId, next_before: "older",
		items: [{ id: "history", type: "assistant_final", text: "saved history" }],
	};
}

test("session history preserves restored decisions and background terminals", async () => {
	for (const method of ["approval.request", "clarify.request"]) {
		let state = reduceRuntimeEvent(sourceState(), "session.changed", { session_id: "target", generation: 2 });
		state = reduceRuntimeEvent(state, "status.changed", {
			session_id: "target", generation: 2, turn_running: false, pending_decision: true, suspended_turn: true,
			background_shells: [{ shell_id: "shell", command_preview: "npm run dev", process_state: "running_background", output: "ready" }],
		});
		state = reduceRuntimeEvent(state, method, {
			session_id: "target", generation: 2, turn_id: "turn", client_turn_id: "client",
			decision_id: "decision", request_id: "question", preview: "Run tests", question: "Which path?",
			options: [{ choice: "approve_once", label: "Approve once" }],
		});
		const decision = method === "approval.request" ? state.pendingApproval : state.pendingClarification;
		assert.ok(decision);
		const controller = new SessionTransitionController({
			current: () => state,
			update: (next) => { state = next; },
			loadTranscript: async () => page("target"),
		});
		assert.equal(await controller.resume({ session_id: "target", generation: 2 }), true);
		assert.strictEqual(method === "approval.request" ? state.pendingApproval : state.pendingClarification, decision);
		assert.equal(state.backgroundShellCount, 1);
		assert.equal(state.backgroundShells.shell?.outputPreview, "ready");
		assert.equal(state.transcript.some((item) => item.id === "source-message"), false);
		assert.equal(state.transcript.some((item) => item.id === "history"), true);
	}
});

test("restoring history preserves new turn events and newer streaming text", async () => {
	let state = reduceRuntimeEvent(sourceState(), "session.changed", { session_id: "target", generation: 2 });
	state = reduceRuntimeEvent(state, "status.changed", { session_id: "target", turn_running: false });
	state = reduceRuntimeEvent(state, "turn.started", { session_id: "target", turn_id: "new-turn", client_turn_id: "new-client" });
	const history = Promise.withResolvers<Record<string, unknown>>();
	const controller = new SessionTransitionController({
		current: () => state,
		update: (next) => { state = next; },
		loadTranscript: () => history.promise,
	});
	const resumed = controller.resume({ session_id: "target", generation: 2 });
	assert.equal(state.turnRunning, true);
	assert.equal(state.activeTurnId, "new-turn");
	state = { ...state, transcript: [{ id: "stream", type: "assistant_stream", text: "latest text" }] };
	history.resolve({ ...page("target"), items: [
		{ id: "history", type: "user", text: "earlier message" },
		{ id: "stream", type: "assistant_stream", text: "stale text" },
	] });
	await resumed;
	assert.deepEqual(state.transcript.map((item) => item.text), ["earlier message", "latest text"]);
	assert.equal(state.activeTurnId, "new-turn");
});

test("late history cannot replace a newer session or generation", async () => {
	for (const sameSession of [false, true]) {
		let state = sourceState();
		const older = Promise.withResolvers<Record<string, unknown>>();
		let loads = 0;
		const controller = new SessionTransitionController({
			current: () => state,
			update: (next) => { state = next; },
			loadTranscript: (sessionId) => ++loads === 1 ? older.promise : Promise.resolve(page(sessionId)),
		});
		const first = controller.resume({ session_id: "target", generation: 2 });
		const newerId = sameSession ? "target" : "newer";
		assert.equal(await controller.resume({ session_id: newerId, generation: 3 }), true);
		const newer = state;
		older.resolve(page("target"));
		assert.equal(await first, false);
		assert.strictEqual(state, newer);
		assert.equal(state.sessionId, newerId);
		assert.equal(state.sessionGeneration, 3);
	}
});

test("stale transition results are rejected before history loading", async () => {
	let state = { ...sourceState(), sessionId: "newer", sessionGeneration: 3 };
	const controller = new SessionTransitionController({
		current: () => state,
		update: () => assert.fail("stale transition changed state"),
		loadTranscript: async () => assert.fail("stale transition loaded history"),
	});
	assert.equal(await controller.resume({ session_id: "target", generation: 2 }), false);
	assert.equal(await controller.resume({ session_id: "target" }, undefined, { sessionId: "source", generation: 1 }), false);
	state = { ...state, sessionGeneration: 4 };
	assert.equal(await controller.resume({ session_id: "newer", generation: 3 }), false);
});

test("clearing or closing invalidates pending history and its errors", async () => {
	for (const reject of [false, true]) {
		let state = sourceState();
		const history = Promise.withResolvers<Record<string, unknown>>();
		const controller = new SessionTransitionController({
			current: () => state,
			update: (next) => { state = next; },
			loadTranscript: () => history.promise,
		});
		const pending = controller.resume({ session_id: "target", generation: 2 });
		controller.invalidate();
		state = { ...state, transcript: [] };
		const cleared = state;
		if (reject) history.reject(new Error("late failure"));
		else history.resolve(page("target"));
		assert.equal(await pending, false);
		assert.strictEqual(state, cleared);
	}
});

test("current history failures keep the activated session and support retry", async () => {
	let state = sourceState();
	let attempts = 0;
	const controller = new SessionTransitionController({
		current: () => state,
		update: (next) => { state = next; },
		loadTranscript: async () => {
			if (++attempts === 1) throw new Error("history unavailable");
			return page("target");
		},
	});
	await assert.rejects(controller.resume({ session_id: "target", generation: 2 }), /history unavailable/);
	assert.equal(state.sessionId, "target");
	assert.equal(state.transcript.length, 0);
	assert.equal(await controller.resume({ session_id: "target", generation: 2 }), true);
	assert.equal(state.transcript[0]?.id, "history");
});

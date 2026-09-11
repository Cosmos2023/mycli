import assert from "node:assert/strict";
import test from "node:test";
import { reduceRuntimeLifecycle } from "../../src/state/runtime-lifecycle-reducer.ts";
import { initialRuntimeState } from "../../src/state/runtime-state-model.ts";
import type { DecodedRuntimeEvent } from "../../src/state/runtime-events.ts";

test("runtime lifecycle reducer owns turn identity from start through matching terminal", () => {
	const idle = {
		...initialRuntimeState(),
		sessionId: "session-1",
		sessionGeneration: 3,
	};
	const started = reduceRuntimeLifecycle(idle, idle, decoded("turn.started", {
		sessionId: "session-1",
		generation: 3,
		turnId: "turn-1",
		clientTurnId: "client-1",
	}));

	assert.equal(started.turnRunning, true);
	assert.equal(started.activeTurnId, "turn-1");
	assert.equal(started.activeClientTurnId, "client-1");

	const completed = reduceRuntimeLifecycle(started, started, decoded("turn.completed", {
		sessionId: "session-1",
		generation: 3,
		turnId: "turn-1",
		clientTurnId: "client-1",
	}));

	assert.equal(completed.turnRunning, false);
	assert.equal(completed.activeTurnId, null);
	assert.equal(completed.activeClientTurnId, null);
});

test("runtime lifecycle reducer does not let a terminal identity clear newer work", () => {
	const active = {
		...initialRuntimeState(),
		turnRunning: true,
		activeTurnId: "turn-new",
		activeClientTurnId: "client-new",
	};
	const reduced = reduceRuntimeLifecycle(active, active, decoded("turn.completed", {
		turnId: "turn-old",
		clientTurnId: "client-old",
	}));

	assert.equal(reduced.turnRunning, true);
	assert.equal(reduced.activeTurnId, "turn-new");
	assert.equal(reduced.activeClientTurnId, "client-new");
});

test("runtime lifecycle reducer requires at least one matching terminal identity", () => {
	const active = {
		...initialRuntimeState(),
		turnRunning: true,
		activeTurnId: "turn-1",
		activeClientTurnId: "client-1",
	};
	const anonymous = reduceRuntimeLifecycle(active, active, decoded("turn.completed", {}));
	assert.strictEqual(anonymous, active);

	const byTurn = reduceRuntimeLifecycle(active, active, decoded("turn.completed", {
		turnId: "turn-1",
	}));
	assert.equal(byTurn.turnRunning, false);
	assert.equal(byTurn.activeTurnId, null);
	assert.equal(byTurn.activeClientTurnId, null);

	const byClient = reduceRuntimeLifecycle(active, active, decoded("turn.completed", {
		clientTurnId: "client-1",
	}));
	assert.equal(byClient.turnRunning, false);
	assert.equal(byClient.activeTurnId, null);
	assert.equal(byClient.activeClientTurnId, null);
});

test("runtime lifecycle reducer rejects terminal identities it cannot correlate", () => {
	const turnOnly = {
		...initialRuntimeState(),
		turnRunning: true,
		activeTurnId: "turn-1",
	};
	assert.strictEqual(
		reduceRuntimeLifecycle(turnOnly, turnOnly, decoded("turn.completed", {
			clientTurnId: "client-unknown",
		})),
		turnOnly,
	);

	const clientOnly = {
		...initialRuntimeState(),
		turnRunning: true,
		activeClientTurnId: "client-1",
	};
	assert.strictEqual(
		reduceRuntimeLifecycle(clientOnly, clientOnly, decoded("turn.completed", {
			turnId: "turn-unknown",
		})),
		clientOnly,
	);
});

test("runtime lifecycle reducer treats status snapshots as authoritative identity snapshots", () => {
	const active = {
		...initialRuntimeState(),
		turnRunning: true,
		activeTurnId: "turn-1",
		activeClientTurnId: "client-1",
	};
	const stopped = reduceRuntimeLifecycle(active, active, {
		...decoded("status.changed", {}),
		params: { turn_running: false },
	});

	assert.equal(stopped.turnRunning, false);
	assert.equal(stopped.activeTurnId, null);
	assert.equal(stopped.activeClientTurnId, null);
});

function decoded(
	method: string,
	ownership: Partial<DecodedRuntimeEvent<string>["ownership"]>,
): DecodedRuntimeEvent<string> {
	return {
		method,
		params: {},
		source: "synthetic",
		ownership: {
			sessionId: ownership.sessionId ?? null,
			generation: ownership.generation ?? null,
			turnId: ownership.turnId ?? null,
			clientTurnId: ownership.clientTurnId ?? null,
		},
	};
}

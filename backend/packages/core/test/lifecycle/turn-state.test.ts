import assert from "node:assert/strict";
import test from "node:test";
import { completeTurn, failTurn, startTurn } from "../../src/index.ts";

test("a running turn completes exactly once", () => {
	const running = startTurn({
		sessionId: "session-1",
		clientTurnId: "client-1",
		turnId: "turn-1",
		startedAt: "2026-08-03T00:00:00.000Z",
	});
	const completed = completeTurn(running, {
		assistantText: "ok",
		completedAt: "2026-08-03T00:00:01.000Z",
	});

	assert.equal(running.status, "in_progress");
	assert.equal(completed.status, "completed");
	assert.equal(completed.assistantText, "ok");
	assert.throws(
		() => completeTurn(completed, {
			assistantText: "late",
			completedAt: "2026-08-03T00:00:02.000Z",
		}),
		/invalid_turn_transition/,
	);
});

test("a running turn records a typed failure", () => {
	const failed = failTurn(startTurn({
		sessionId: "session-1",
		clientTurnId: "client-1",
		turnId: "turn-1",
		startedAt: "2026-08-03T00:00:00.000Z",
	}), {
		code: "auth_error",
		message: "Authentication failed.",
		completedAt: "2026-08-03T00:00:01.000Z",
	});

	assert.deepEqual(
		{ status: failed.status, code: failed.errorCode, message: failed.errorMessage },
		{ status: "failed", code: "auth_error", message: "Authentication failed." },
	);
});

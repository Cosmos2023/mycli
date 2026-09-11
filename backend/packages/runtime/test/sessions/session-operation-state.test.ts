import assert from "node:assert/strict";
import test from "node:test";
import {
	abortSessionTransition,
	beginSessionTransition,
	claimSessionExecution,
	commitSessionTransition,
	createSessionOperationState,
	isSessionOperationContextCurrent,
	releaseSessionExecution,
	sessionOperationContext,
} from "../../src/sessions/session-operation-state.ts";

const source = Object.freeze({ sessionId: "session-source", generation: 1 });

test("creates a frozen idle state with a normalized generation context", () => {
	const state = createSessionOperationState({ sessionId: " session-source ", generation: 1 });

	assert.deepEqual(state, { phase: "idle", context: source });
	assert.ok(Object.isFrozen(state));
	assert.ok(Object.isFrozen(sessionOperationContext(state)));
	assert.equal(isSessionOperationContextCurrent(state, source), true);
	assert.equal(
		isSessionOperationContextCurrent(state, { sessionId: source.sessionId, generation: 2 }),
		false,
	);
});

test("execution claims are exclusive and require exact claim identity for release", () => {
	const idle = createSessionOperationState(source);
	const acquired = claimSessionExecution(idle, source);
	assert.ok(acquired);
	assert.equal(acquired.state.phase, "executing");
	assert.equal(claimSessionExecution(acquired.state, source), undefined);
	assert.equal(beginSessionTransition(acquired.state, source), undefined);

	const clone = { ...acquired.claim };
	assert.equal(releaseSessionExecution(acquired.state, clone), undefined);
	const released = releaseSessionExecution(acquired.state, acquired.claim);
	assert.deepEqual(released, { phase: "idle", context: source });
	assert.equal(releaseSessionExecution(released!, acquired.claim), undefined);
});

test("stale generation and wrong-session contexts cannot claim ownership", () => {
	const idle = createSessionOperationState(source);

	assert.equal(
		claimSessionExecution(idle, { ...source, generation: source.generation + 1 }),
		undefined,
	);
	assert.equal(
		beginSessionTransition(idle, { ...source, sessionId: "session-other" }),
		undefined,
	);
});

test("transition commit advances the context once and returns to idle", () => {
	const idle = createSessionOperationState(source);
	const begun = beginSessionTransition(idle, source);
	assert.ok(begun);
	assert.equal(begun.state.phase, "transitioning");
	assert.equal(claimSessionExecution(begun.state, source), undefined);

	const wrongClaim = { ...begun.claim };
	assert.equal(
		commitSessionTransition(begun.state, wrongClaim, {
			sessionId: "session-target",
			generation: 2,
		}),
		undefined,
	);
	const committed = commitSessionTransition(begun.state, begun.claim, {
		sessionId: "session-target",
		generation: 2,
	});
	assert.deepEqual(committed, {
		phase: "idle",
		context: { sessionId: "session-target", generation: 2 },
	});
});

test("transition abort restores the original idle context", () => {
	const begun = beginSessionTransition(createSessionOperationState(source), source);
	assert.ok(begun);

	const restored = abortSessionTransition(begun.state, begun.claim);
	assert.deepEqual(restored, { phase: "idle", context: source });
	assert.equal(abortSessionTransition(restored!, begun.claim), undefined);
});

test("transition commit rejects skipped or repeated generations", () => {
	const begun = beginSessionTransition(createSessionOperationState(source), source);
	assert.ok(begun);

	assert.throws(
		() => commitSessionTransition(begun.state, begun.claim, {
			sessionId: "session-target",
			generation: 3,
		}),
		/session generation must advance exactly once/u,
	);
});

test("invalid initial contexts are rejected", () => {
	assert.throws(
		() => createSessionOperationState({ sessionId: " ", generation: 1 }),
		TypeError,
	);
	assert.throws(
		() => createSessionOperationState({ sessionId: "session", generation: 0 }),
		TypeError,
	);
});

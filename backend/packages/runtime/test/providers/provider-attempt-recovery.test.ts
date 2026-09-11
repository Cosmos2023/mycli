import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderAttemptUpdate } from "@mycli/contracts";
import { parseProviderAttemptUpdate, runtimeErrorPublicMessage } from "@mycli/contracts";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { ProviderFailure } from "@mycli/providers";
import { ProviderAgentLoop, normalizeProviderAgentLoopFailure, type ProviderAgentLoopInput } from "../../src/providers/provider-agent-loop.ts";

const NOW = "2026-09-07T08:00:00.000Z";
const REQUEST: ProviderRequest = {
	provider: "deepseek", protocol: "chat_completions", model: "fixture", instructions: "fixture",
	messages: [{ role: "user", content: "fixture" }], tools: [],
};

test("provider dispatch waits for the durable start acknowledgement", async () => {
	const pending = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	let calls = 0;
	const updates: ProviderAttemptUpdate[] = [];
	const result = new ProviderAgentLoop().runStep(input({
		provider: { stream: async function* (): AsyncIterable<ProviderEvent> {
			calls += 1; yield { type: "text_delta", text: "done" }; yield { type: "completed" };
		} },
		recordAttempt: async (update) => {
			updates.push(update);
			if (update.state === "started") { reached.resolve(); await pending.promise; }
		},
	}));
	await reached.promise;
	assert.equal(calls, 0);
	pending.resolve();
	assert.equal("failure" in await result, false);
	assert.equal(calls, 1);
	assert.deepEqual(updates.map((update) => update.state), ["started", "completed"]);
});

test("failed and scheduled attempts commit before waiting, with charged budgets and safe recovery", async () => {
	const updates: ProviderAttemptUpdate[] = [];
	let calls = 0;
	const result = await new ProviderAgentLoop().runStep(input({
		provider: { stream: async function* (): AsyncIterable<ProviderEvent> {
			calls += 1;
			if (calls === 1) { yield { type: "reasoning_delta", text: "partial" }; throw disconnected(); }
			yield { type: "text_delta", text: "done" }; yield { type: "completed" };
		} },
		recordAttempt: async (update) => { updates.push(update); },
		sleep: async () => {
			assert.equal(updates.at(-1)?.state, "scheduled");
			assert.equal(updates.at(-1)?.streamRetriesUsed, 1);
			assert.equal(updates.at(-1)?.retryAt, "2026-09-07T08:00:00.200Z");
			assert.equal(updates.at(-1)?.resetOutput, true);
			assert.equal(calls, 1);
		},
	}));
	assert.equal("failure" in result, false);
	assert.deepEqual(updates.map((update) => [update.sequence, update.attempt, update.state]), [
		[1, 1, "started"], [2, 1, "failed"], [3, 2, "scheduled"], [4, 2, "started"], [5, 2, "recovered"],
	]);
	assert(updates.every((update) => update.attempt === 1 + update.requestRetriesUsed + update.streamRetriesUsed));
});

test("attempt write failures stop dispatch and never become provider retries", async (context) => {
	for (const failedState of ["started", "failed", "scheduled", "recovered", "exhausted"] as const) {
		await context.test(failedState, async () => {
			let calls = 0;
			let writesAfterFailure = 0;
			let rejected = false;
			const run = new ProviderAgentLoop().runStep(input({
				provider: { stream: async function* (): AsyncIterable<ProviderEvent> {
					calls += 1;
					if (calls === 1 || failedState === "exhausted") throw disconnected();
					yield { type: "tool_call", callId: "one", name: "Read", argumentsJson: "{}" };
					yield { type: "completed" };
				} },
				recordAttempt: async (update) => {
					if (rejected) writesAfterFailure += 1;
					if (update.state === failedState) { rejected = true; throw new Error("private sqlite details"); }
				},
			}));
			await assert.rejects(run, (error: unknown) => {
				assert(error instanceof ProviderFailure);
				assert.equal(error.code, "persistence_error");
				assert.equal(error.retryable, false);
				assert.doesNotMatch(error.message, /private/u);
				return true;
			});
			assert.equal(calls, failedState === "started" ? 0 : ["recovered", "exhausted"].includes(failedState) ? 2 : 1);
			assert.equal(writesAfterFailure, 0);
		});
	}
});

test("cancellation while start acknowledgement is pending dispatches nothing and is persisted", async () => {
	const controller = new AbortController();
	const updates: ProviderAttemptUpdate[] = [];
	let calls = 0;
	const result = await new ProviderAgentLoop().runStep(input({
		signal: controller.signal,
		normalizeFailure: (error) => normalizeProviderAgentLoopFailure(error, controller.signal),
		provider: { stream: async function* (): AsyncIterable<ProviderEvent> { calls += 1; yield { type: "completed" }; } },
		recordAttempt: async (update) => { updates.push(update); if (update.state === "started") controller.abort(); },
	}));
	assert.equal(calls, 0);
	assert("failure" in result && result.failure.code === "interrupted");
	assert.deepEqual(updates.map((update) => update.state), ["started", "cancelled"]);
});

test("cancelled backoff preserves its reservation and never sends a second request", async () => {
	const controller = new AbortController();
	const updates: ProviderAttemptUpdate[] = [];
	let calls = 0;
	const result = await new ProviderAgentLoop().runStep(input({
		signal: controller.signal,
		normalizeFailure: (error) => normalizeProviderAgentLoopFailure(error, controller.signal),
		provider: { stream: (): AsyncIterable<ProviderEvent> => { calls += 1; throw disconnected(); } },
		recordAttempt: async (update) => { updates.push(update); },
		sleep: async () => { controller.abort(); },
	}));
	assert("failure" in result && result.failure.code === "interrupted");
	assert.equal(calls, 1);
	assert.equal(updates.at(-1)?.state, "cancelled");
	assert.equal(updates.at(-1)?.streamRetriesUsed, 1);
	assert.equal(updates.at(-1)?.attempt, 2);
});

test("resuming a scheduled attempt restores its budget and ignores later policy changes", async () => {
	const updates: ProviderAttemptUpdate[] = [];
	let calls = 0;
	const result = await new ProviderAgentLoop().runStep(input({
		requestMaxRetries: 100, maxRetries: 100,
		attemptState: scheduled(),
		provider: { stream: (): AsyncIterable<ProviderEvent> => { calls += 1; throw disconnected(); } },
		recordAttempt: async (update) => { updates.push(update); },
	}));
	assert("failure" in result && result.failure.code === "retry_exhausted");
	assert.equal(calls, 1);
	assert.deepEqual(updates.map((update) => [update.sequence, update.attempt, update.state]), [
		[4, 2, "started"], [5, 2, "failed"], [6, 2, "exhausted"],
	]);
	assert(updates.every((update) => update.policy.streamMaxRetries === 1 && update.policy.requestMaxRetries === 0));
});

test("loading a started or unknown attempt never replays an uncertain provider request", async () => {
	for (const state of ["started", "unknown"] as const) {
		let calls = 0;
		const result = await new ProviderAgentLoop().runStep(input({
			attemptState: parseProviderAttemptUpdate({ sequence: 1, attempt: 1, state,
				policy: { requestMaxRetries: 0, streamMaxRetries: 1 }, requestRetriesUsed: 0, streamRetriesUsed: 0, observedAt: NOW }),
			provider: { stream: async function* (): AsyncIterable<ProviderEvent> { calls += 1; yield { type: "completed" }; } },
		}));
		assert("failure" in result && result.failure.code === "interrupted");
		assert.equal(calls, 0);
	}
});

test("immediate retry deadlines use one timestamp and commit latency does not add another delay", async () => {
	let now = Date.parse(NOW);
	let calls = 0;
	const updates: ProviderAttemptUpdate[] = [];
	const result = await new ProviderAgentLoop().runStep(input({
		clock: () => new Date(now++).toISOString(),
		provider: { stream: async function* (): AsyncIterable<ProviderEvent> {
			calls += 1;
			if (calls === 1) throw new ProviderFailure({
				code: "response_stream_error", message: "busy", retryable: true, retryAfterSeconds: 0,
			});
			yield { type: "completed" };
		} },
		recordAttempt: async (update) => { updates.push(update); now += 500; },
		sleep: async (delay) => { assert.equal(delay, 0); },
	}));
	assert.equal("failure" in result, false);
	assert.equal(calls, 2);
	const scheduledUpdate = updates.find((update) => update.state === "scheduled")!;
	assert.equal(scheduledUpdate.observedAt, scheduledUpdate.retryAt);
});

function input(overrides: Partial<ProviderAgentLoopInput>): ProviderAgentLoopInput {
	const signal = new AbortController().signal;
	return {
		request: REQUEST, requestMaxRetries: 0, maxRetries: 1, signal, toolCallsAllowed: true,
		provider: { stream: async function* (): AsyncIterable<ProviderEvent> { yield { type: "completed" }; } },
		emit: () => undefined, normalizeFailure: (error) => normalizeProviderAgentLoopFailure(error, signal),
		sleep: async () => undefined, random: () => 0.5, clock: () => NOW, ...overrides,
	};
}

function disconnected(): ProviderFailure {
	return new ProviderFailure({ code: "response_stream_error", message: "stream disconnected", retryable: true });
}

function scheduled(): ProviderAttemptUpdate {
	return parseProviderAttemptUpdate({
		sequence: 3, attempt: 2, state: "scheduled", policy: { requestMaxRetries: 0, streamMaxRetries: 1 },
		requestRetriesUsed: 0, streamRetriesUsed: 1, observedAt: NOW, retryAt: NOW, recoveryKind: "stream", resetOutput: true,
		failure: { code: "response_stream_error", message: runtimeErrorPublicMessage("response_stream_error"), retryable: true },
	});
}

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { threadId } from "node:worker_threads";
import test from "node:test";
import type { NodeRuntimeConfig } from "@mycli/config";
import type { ProviderRequest, RuntimeEvent } from "@mycli/core";
import {
	AgentWorkerPool,
	type ProviderStreamDiagnostics,
	WorkerProviderStepExecutor,
} from "../src/index.ts";

test("executes a provider step in the leased Worker and returns streamed events", async (t) => {
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end([
				'data: {"id":"chatcmpl-worker","choices":[{"delta":{"content":"worker"},"finish_reason":null}]}',
				"",
				'data: {"id":"chatcmpl-worker","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
				"",
				"data: [DONE]",
				"",
			].join("\n"));
		});
	});
	await listen(server);
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	}));
	const address = server.address();
	assert(address && typeof address !== "string");
	const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const lease = await pool.acquire({
		priority: "background",
		source: "subagent",
		sessionId: "child-session",
		turnId: "child-turn",
	});
	assert.notEqual(lease.threadId, threadId);
	const executor = new WorkerProviderStepExecutor({
		lease,
		createRequestId: () => "provider-request-1",
	});
	const events: RuntimeEvent[] = [];
	const diagnostics: ProviderStreamDiagnostics[] = [];

	const result = await executor.execute({
		config: config(`http://127.0.0.1:${address.port}/v1`),
		provider: { stream: coordinatorProviderMustNotRun },
		request: providerRequest(),
		timelineWindowId: "window-1",
		timelineVersion: 1,
		maxRetries: 0,
		toolCallsAllowed: false,
		signal: new AbortController().signal,
		emit: (event) => events.push(event),
		recordDiagnostic: (diagnostic) => {
			diagnostics.push(diagnostic);
			throw new Error("diagnostic sink failed");
		},
	});

	assert.equal("failure" in result, false);
	if ("failure" in result) return;
	assert.equal(result.assistantText, "worker");
	assert.deepEqual(result.usage, {
		input_tokens: 3,
		output_tokens: 2,
		total_tokens: 5,
	});
	assert.equal(result.responseId, "chatcmpl-worker");
	assert.deepEqual(events, [
		{ type: "text_delta", text: "worker" },
		{ type: "message_complete", responseId: "chatcmpl-worker" },
	]);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0]?.success, true);
	assert.equal(diagnostics[0]?.attempt, 1);
	assert.equal(diagnostics[0]?.textBytes, 6);
	assert.equal(diagnostics[0]?.textEventCount, 1);
	assert.equal(diagnostics[0]?.completedEventCount, 1);
	assert.equal(typeof diagnostics[0]?.ttfbMs, "number");
	assert.equal(typeof diagnostics[0]?.ttftMs, "number");
	await lease.release();
	assert.equal(pool.snapshot().activeLeaseCount, 0);
});

test("aborts only the active provider request on its lease", async (t) => {
	let requestClosed = false;
	const server = createServer((request, response) => {
		request.once("close", () => { requestClosed = true; });
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write('data: {"id":"chatcmpl-blocked","choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
	});
	await listen(server);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address !== "string");
	const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const lease = await pool.acquire({
		priority: "background",
		source: "subagent",
		sessionId: "child-session",
		turnId: "child-turn",
	});
	const controller = new AbortController();
	const events: RuntimeEvent[] = [];
	const executing = new WorkerProviderStepExecutor({ lease }).execute({
		config: config(`http://127.0.0.1:${address.port}/v1`),
		provider: { stream: coordinatorProviderMustNotRun },
		request: providerRequest(),
		timelineWindowId: "window-1",
		timelineVersion: 1,
		maxRetries: 0,
		toolCallsAllowed: false,
		signal: controller.signal,
		emit: (event) => events.push(event),
	});
	await waitFor(() => events.some((event) => event.type === "text_delta"));
	controller.abort();

	const result = await executing;
	assert.equal("failure" in result, true);
	if (!("failure" in result)) return;
	assert.equal(result.failure.code, "interrupted");
	await waitFor(() => requestClosed);
	await lease.release();
});

test("fences a stale provider frame before network dispatch and replaces the Worker", async (t) => {
	let requests = 0;
	const server = createServer((request, response) => {
		requests += 1;
		request.resume();
		response.writeHead(500).end();
	});
	await listen(server);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address !== "string");
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		idleTimeoutMs: 5_000,
		coordinatorEpoch: "epoch-current",
	});
	t.after(async () => pool.close());
	const lease = await pool.acquire({
		priority: "background",
		source: "subagent",
		sessionId: "child-session",
		turnId: "child-turn",
	});
	const generation = lease.workerGeneration;

	lease.postMessage({
		type: "provider_step_execute",
		protocolVersion: 1,
		coordinatorEpoch: "epoch-stale",
		workerId: lease.workerId,
		workerGeneration: lease.workerGeneration,
		leaseId: lease.leaseId,
		jobId: lease.jobId,
		sessionId: lease.sessionId,
		turnId: lease.turnId,
		timelineWindowId: "window-1",
		timelineVersion: 1,
		requestId: "provider-stale-1",
		sequence: 1,
		config: {
			provider: "openai",
			protocol: "chat_completions",
			apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
			apiKey: "test-key",
		},
		request: providerRequest(),
		requestMaxRetries: 0,
		maxRetries: 0,
		toolCallsAllowed: false,
	});

	assert.deepEqual(await lease.failure, {
		code: "worker_failed",
		message: "worker protocol failure",
	});
	await waitFor(() => pool.snapshot().workers.some((worker) => (
		worker.workerId === lease.workerId
		&& worker.workerGeneration > generation
		&& worker.state === "idle"
	)));
	assert.equal(requests, 0);
});

test("rejects stale provider compound-fence fields with zero network dispatch", async (t) => {
	let requests = 0;
	const server = createServer((request, response) => {
		requests += 1;
		request.resume();
		response.writeHead(500).end();
	});
	await listen(server);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address !== "string");
	const staleFields = [
		["sessionId", "session-stale"],
		["turnId", "turn-stale"],
		["sequence", 2],
	] as const;

	for (const [field, staleValue] of staleFields) {
		await t.test(field, async (subtest) => {
			const requestsBefore = requests;
			const pool = new AgentWorkerPool({
				maxWorkers: 1,
				idleTimeoutMs: 5_000,
				coordinatorEpoch: `epoch-${field}`,
			});
			subtest.after(async () => pool.close());
			const lease = await pool.acquire({
				priority: "background",
				source: "subagent",
				sessionId: "child-session",
				turnId: "child-turn",
			});
			const generation = lease.workerGeneration;
			const command = {
				type: "provider_step_execute" as const,
				protocolVersion: 1 as const,
				coordinatorEpoch: lease.coordinatorEpoch,
				workerId: lease.workerId,
				workerGeneration: lease.workerGeneration,
				leaseId: lease.leaseId,
				jobId: lease.jobId,
				sessionId: lease.sessionId,
				turnId: lease.turnId,
				timelineWindowId: "window-1",
				timelineVersion: 1,
				requestId: `provider-stale-${field}`,
				sequence: 1,
				config: {
					provider: "openai" as const,
					protocol: "chat_completions" as const,
					apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
					apiKey: "test-key",
				},
				request: providerRequest(),
				requestMaxRetries: 0,
				maxRetries: 0,
				toolCallsAllowed: false,
			};

			lease.postMessage({ ...command, [field]: staleValue });

			assert.deepEqual(await lease.failure, {
				code: "worker_failed",
				message: "worker protocol failure",
			});
			await waitFor(() => pool.snapshot().workers.some((worker) => (
				worker.workerId === lease.workerId
				&& worker.workerGeneration > generation
				&& worker.state === "idle"
			)));
			assert.equal(requests, requestsBefore);
		});
	}
});

test("rejects stale provider timeline state after establishing the Worker high-water mark", async (t) => {
	let requests = 0;
	const server = createServer((request, response) => {
		requests += 1;
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end([
				'data: {"id":"chatcmpl-worker","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":1}}',
				"",
				"data: [DONE]",
				"",
			].join("\n"));
		});
	});
	await listen(server);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address !== "string");
	const scenarios = [
		{
			name: "non-contiguous version",
			accepted: [["window-a", 1]] as const,
			staleWindowId: "window-a",
			staleVersion: 3,
		},
		{
			name: "prior window after replacement",
			accepted: [["window-a", 1], ["window-b", 1]] as const,
			staleWindowId: "window-a",
			staleVersion: 2,
		},
	] as const;

	for (const scenario of scenarios) {
		await t.test(scenario.name, async (subtest) => {
			const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
			subtest.after(async () => pool.close());
			const lease = await pool.acquire({
				priority: "background",
				source: "subagent",
				sessionId: "child-session",
				turnId: "child-turn",
			});
			const generation = lease.workerGeneration;
			const executor = new WorkerProviderStepExecutor({
				lease,
				createRequestId: (() => {
					let next = 0;
					return () => `accepted-request-${next += 1}`;
				})(),
			});
			const input = (timelineWindowId: string, timelineVersion: number) => ({
				config: config(`http://127.0.0.1:${address.port}/v1`),
				provider: { stream: coordinatorProviderMustNotRun },
				request: providerRequest(),
				timelineWindowId,
				timelineVersion,
				maxRetries: 0,
				toolCallsAllowed: false,
				signal: new AbortController().signal,
				emit: () => undefined,
			});
			const requestsBefore = requests;
			for (const [windowId, version] of scenario.accepted) {
				await executor.execute(input(windowId, version));
			}
			const acceptedRequests = requestsBefore + scenario.accepted.length;
			assert.equal(requests, acceptedRequests);

			lease.postMessage({
				type: "provider_step_execute",
				protocolVersion: 1,
				coordinatorEpoch: lease.coordinatorEpoch,
				workerId: lease.workerId,
				workerGeneration: lease.workerGeneration,
				leaseId: lease.leaseId,
				jobId: lease.jobId,
				sessionId: lease.sessionId,
				turnId: lease.turnId,
				timelineWindowId: scenario.staleWindowId,
				timelineVersion: scenario.staleVersion,
				requestId: "provider-stale-timeline",
				sequence: scenario.accepted.length + 1,
				config: {
					provider: "openai",
					protocol: "chat_completions",
					apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
					apiKey: "test-key",
				},
				request: providerRequest(),
				requestMaxRetries: 0,
				maxRetries: 0,
				toolCallsAllowed: false,
			});

			assert.deepEqual(await lease.failure, {
				code: "worker_failed",
				message: "worker protocol failure",
			});
			await waitFor(() => pool.snapshot().workers.some((worker) => (
				worker.workerId === lease.workerId
				&& worker.workerGeneration > generation
				&& worker.state === "idle"
			)));
			assert.equal(requests, acceptedRequests);
		});
	}
});

function config(apiBaseUrl: string): NodeRuntimeConfig {
	return {
		workspaceRoot: "/workspace",
		homeDir: "/home/test",
		provider: "openai",
		protocol: "chat_completions",
		model: "test-model",
		apiBaseUrl,
		apiKey: "test-key",
		authRef: "test",
		sessionId: "child-session",
		sessionsDbPath: "/tmp/test.db",
		maxPromptTokens: 10_000,
		requestMaxRetries: 0,
		streamMaxRetries: 0,
		reasoningEffort: "none",
		thinkingEnabled: false,
		supportsImages: false,
		webSearchMode: "disabled",
		promptCacheKeyEnabled: false,
		cacheControlEnabled: false,
		memoryEnabled: false,
		requestPermissionsToolEnabled: false,
		updatesCheckOnStartup: true,
		compressionThresholdTokens: 8_000,
		compactionTokenLimit: 9_600,
		compactionReservedOutputTokens: 13_000,
		compactionTailTurns: 2,
		compactionTailMaxTokens: 8_000,
		compactionTriggerRatio: 0.9,
		compactionBufferTokens: 13_000,
		compactionInputCostPer1k: 0,
		compactionOutputCostPer1k: 0,
		compactionCarryCostPer1k: 0,
		compactionExpectedSummaryTokens: 500,
		compactionCarryTurns: 1,
		compactionTriggerRatiosByModel: {},
		compactionRehydrationFileMaxTotalTokens: 50_000,
		compactionRehydrationFileMaxItemTokens: 5_000,
		compactionRehydrationMaxFiles: 5,
	};
}

function providerRequest(): ProviderRequest {
	return Object.freeze({
		provider: "openai",
		protocol: "chat_completions",
		model: "test-model",
		instructions: "You are mycli.",
		messages: Object.freeze([{ role: "user" as const, content: "hello" }]),
		tools: Object.freeze([]),
	});
}

function coordinatorProviderMustNotRun(): AsyncIterable<never> {
	throw new Error("coordinator provider used");
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function waitFor(read: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("timed_out_waiting_for_worker_provider");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

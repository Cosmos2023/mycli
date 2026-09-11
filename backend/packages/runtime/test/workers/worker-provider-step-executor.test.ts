import assert from "node:assert/strict";
import { createServer } from "node:http";
import { threadId } from "node:worker_threads";
import test from "node:test";
import type { NodeRuntimeConfig } from "@mycli/config";
import type { ProviderEvent, ProviderRequest, RuntimeEvent } from "@mycli/core";
import { providerNativeEndpointSha256 } from "@mycli/core";
import { ProviderFailure, providerFailureToRuntimeFailure } from "@mycli/providers";
import { createErrorContext } from "@mycli/contracts";
import type { ProviderAttemptUpdate } from "@mycli/contracts";
import { InProcessProviderStepExecutor } from "../../src/providers/provider-step-executor.ts";
import {
	AGENT_WORKER_PROVIDER_RPC_MAX_BYTES,
	AGENT_WORKER_PROTOCOL_VERSION,
	AgentWorkerPool,
	AgentWorkerLease,
	parseAgentWorkerProviderCommand,
	parseAgentWorkerProviderResponse,
	type AgentWorkerProviderCommand,
	type ProviderStepExecutionInput,
	type ProviderStreamDiagnostics,
	WorkerProviderStepExecutor,
	UserTurnCancellation,
} from "../../src/index.ts";

test("Worker attempt dispatch waits for its durable start acknowledgement", async (t) => {
	let requests = 0;
	const server = createServer((request, response) => {
		requests += 1;
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end('data: {"id":"ack-result","choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await listen(server);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address !== "string");
	const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
	const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const lease = await pool.acquire({ priority: "interactive", source: "root", sessionId: "ack-session", turnId: "ack-turn" });
	let releaseWrite!: () => void;
	let enteredWrite!: () => void;
	const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
	const writing = new Promise<void>((resolve) => { releaseWrite = resolve; });
	const updates: ProviderAttemptUpdate[] = [];
	const events: RuntimeEvent[] = [];
	const execution = new WorkerProviderStepExecutor({ lease }).execute({
		...workerInput(apiBaseUrl),
		requestId: "durable-request-ack",
		emit: (event) => events.push(event),
		recordAttempt: async (update) => {
			if (update.state === "started") { enteredWrite(); await writing; }
			updates.push(update);
		},
	});
	await entered;
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	assert.equal(requests, 0);
	assert.equal(events.length, 0);
	releaseWrite();
	assert(!("failure" in await execution));
	assert.equal(requests, 1);
	assert.deepEqual(updates.map((update) => update.state), ["started", "completed"]);
	assert.deepEqual(updates.map((update) => update.sequence), [1, 2]);
	await lease.release();
});

test("Worker persistence failure fences the lease without acknowledgement or network dispatch", async (t) => {
	let requests = 0;
	const server = createServer((request, response) => { requests += 1; request.resume(); response.end(); });
	await listen(server);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address !== "string");
	const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const lease = await pool.acquire({ priority: "interactive", source: "root", sessionId: "ack-session", turnId: "ack-turn" });
	const result = await new WorkerProviderStepExecutor({ lease }).execute({
		...workerInput(`http://127.0.0.1:${address.port}/v1`),
		requestId: "durable-request-failure",
		recordAttempt: async () => { throw new Error("private-persistence-detail"); },
	});
	assert("failure" in result);
	assert.equal(result.failure.code, "persistence_error");
	assert.doesNotMatch(JSON.stringify(result), /private-persistence-detail/u);
	assert.equal(requests, 0);
	assert.equal(pool.snapshot().activeLeaseCount, 0);
});

test("Worker restoration keeps the already charged retry budget despite changed configuration", async (t) => {
	let requests = 0;
	const server = createServer((request, response) => {
		requests += 1;
		request.resume();
		response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
		response.end('{"error":{"type":"server_error","message":"temporarily unavailable"}}');
	});
	await listen(server);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address !== "string");
	const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
	const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const lease = await pool.acquire({ priority: "interactive", source: "root", sessionId: "ack-session", turnId: "ack-turn" });
	const updates: ProviderAttemptUpdate[] = [];
	const result = await new WorkerProviderStepExecutor({ lease }).execute({
		...workerInput(apiBaseUrl),
		config: { ...config(apiBaseUrl), requestMaxRetries: 100, streamMaxRetriesByProvider: { openai: 100 } },
		requestId: "durable-request-restored",
		attemptState: {
			sequence: 3, attempt: 2, state: "scheduled", policy: { requestMaxRetries: 1, streamMaxRetries: 0 },
			requestRetriesUsed: 1, streamRetriesUsed: 0, observedAt: "2000-01-01T00:00:00.000Z",
			retryAt: "2000-01-01T00:00:00.000Z", recoveryKind: "request", resetOutput: false,
			failure: { code: "connection_error", message: "provider connection failed", retryable: true },
		},
		recordAttempt: async (update) => { updates.push(update); },
	});
	assert("failure" in result);
	assert.equal(result.failure.code, "retry_exhausted");
	assert.equal(requests, 1);
	assert.deepEqual(updates.map((update) => update.sequence), [4, 5, 6]);
	assert.deepEqual(updates.map((update) => update.state), ["started", "failed", "exhausted"]);
	assert(updates.every((update) => update.attempt === 2 && update.requestRetriesUsed === 1));
	await lease.release();
});

test("Worker cancellation during start ACK, scheduled ACK, or backoff never dispatches another attempt", async (t) => {
	for (const mode of ["started", "scheduled", "backoff"] as const) {
		await t.test(mode, async (t) => {
			let requests = 0;
			const server = createServer((request, response) => {
				requests += 1;
				request.resume();
				response.writeHead(503, { "content-type": "application/json", "retry-after": "60" });
				response.end('{"error":{"type":"server_error","message":"temporarily unavailable"}}');
			});
			await listen(server);
			t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
			const address = server.address();
			assert(address && typeof address !== "string");
			const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
			const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
			t.after(async () => pool.close());
			const lease = await pool.acquire({ priority: "interactive", source: "root", sessionId: "ack-session", turnId: "ack-turn" });
			const controller = new AbortController();
			const updates: ProviderAttemptUpdate[] = [];
			let releaseWrite!: () => void;
			let enteredWrite!: () => void;
			const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
			const writing = new Promise<void>((resolve) => { releaseWrite = resolve; });
			const execution = new WorkerProviderStepExecutor({ lease }).execute({
				...workerInput(apiBaseUrl),
				config: { ...config(apiBaseUrl), requestMaxRetries: 1 },
				requestId: `durable-cancel-${mode}`,
				signal: controller.signal,
				recordAttempt: async (update) => {
					if (update.state === mode) { enteredWrite(); await writing; }
					updates.push(update);
				},
				emit: (event) => {
					if (event.type === "stream_retrying") {
						assert.equal(updates.at(-1)?.state, "scheduled");
						if (mode === "backoff") controller.abort();
					}
				},
			});
			if (mode !== "backoff") {
				await entered;
				controller.abort();
				releaseWrite();
			}
			const result = await execution;
			assert("failure" in result);
			assert.equal(result.failure.code, "interrupted");
			assert.equal(requests, mode === "started" ? 0 : 1);
			assert.equal(updates.at(-1)?.state, "cancelled");
			await lease.release();
		});
	}
});

test("coordinator commits duplicate attempt proposals once and acknowledges identical delivery", async () => {
	const fixture = controlledLease();
	const updates: ProviderAttemptUpdate[] = [];
	let finishWrite!: () => void;
	const writing = new Promise<void>((resolve) => { finishWrite = resolve; });
	const result = new WorkerProviderStepExecutor({ lease: fixture.lease }).execute({
		...workerInput("https://example.invalid"),
		requestId: "durable-request",
		recordAttempt: async (update) => { await writing; updates.push(update); },
	});
	fixture.deliver({ type: "provider_step_attempt", sequence: 1, update: attemptUpdate(1, "started") });
	fixture.deliver({ type: "provider_step_attempt", sequence: 1, update: attemptUpdate(1, "started") });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(fixture.commands.length, 1);
	finishWrite();
	await waitFor(() => fixture.commands.length === 3);
	assert.deepEqual(updates.map((update) => update.sequence), [1]);
	assert.deepEqual(fixture.commands.map((command) => command.sequence), [1, 2, 3]);
	fixture.deliver({ type: "provider_step_attempt", sequence: 2, update: attemptUpdate(2, "completed") });
	await waitFor(() => fixture.commands.length === 4);
	fixture.deliver({ type: "provider_step_result", sequence: 3, result: { assistantText: "done", usage: {}, toolCalls: [], webSearchCalls: [] } });
	assert(!("failure" in await result));
	assert.equal(updates.length, 2);
	assert.equal(fixture.terminated(), false);
});

test("coordinator rejects stale fences and conflicting attempt delivery without acknowledging", async (t) => {
	for (const mode of ["stale", "conflict", "gap", "policy"] as const) {
		await t.test(mode, async () => {
			const fixture = controlledLease();
			let writes = 0;
			const result = new WorkerProviderStepExecutor({ lease: fixture.lease }).execute({
				...workerInput("https://example.invalid"), requestId: "durable-request",
				recordAttempt: async () => { writes += 1; },
			});
			const rejection = assert.rejects(result, /provider/u);
			if (mode === "conflict") {
				fixture.deliver({ type: "provider_step_attempt", sequence: 1, update: attemptUpdate(1, "started") });
				await waitFor(() => fixture.commands.length === 2);
				fixture.deliver({ type: "provider_step_attempt", sequence: 1, update: { ...attemptUpdate(1, "started"), observedAt: "2026-09-07T06:00:01.000Z" } });
			} else {
				fixture.deliver({
					type: "provider_step_attempt", sequence: 1,
					...(mode === "stale" ? { requestId: "foreign-request" } : {}),
					update: {
						...attemptUpdate(mode === "gap" ? 2 : 1, "started"),
						...(mode === "policy" ? { policy: { requestMaxRetries: 1, streamMaxRetries: 0 } } : {}),
					},
				});
			}
			await rejection;
			assert.equal(writes, mode === "conflict" ? 1 : 0);
			assert.equal(fixture.commands.length, mode === "conflict" ? 2 : 1);
			assert.equal(fixture.terminated(), true);
		});
	}
});

test("advisory Worker diagnostic payload errors preserve committed success", async (t) => {
	for (const diagnostic of [{ futureTimingMs: 12 }, { elapsedMs: -1 }, null]) {
		await t.test(JSON.stringify(diagnostic), async () => {
			const fixture = controlledLease();
			const updates: ProviderAttemptUpdate[] = [];
			let published = 0;
			const execution = new WorkerProviderStepExecutor({ lease: fixture.lease }).execute({
				...workerInput("https://example.invalid"), requestId: "durable-request",
				recordAttempt: async (update) => { updates.push(update); },
				recordDiagnostic: () => { published += 1; },
			});
			fixture.deliver({ type: "provider_step_attempt", sequence: 1, update: attemptUpdate(1, "started") });
			await waitFor(() => fixture.commands.length === 2);
			fixture.deliver({ type: "provider_step_attempt", sequence: 2, update: attemptUpdate(2, "completed") });
			await waitFor(() => fixture.commands.length === 3);
			fixture.deliver({ type: "provider_step_diagnostic", sequence: 3, diagnostic });
			fixture.deliver({ type: "provider_step_result", sequence: 4, result: { assistantText: "done", usage: {}, toolCalls: [], webSearchCalls: [] } });
			assert(!("failure" in await execution));
			assert.deepEqual(updates.map((update) => update.state), ["started", "completed"]);
			assert.equal(published, 0);
			assert.equal(fixture.terminated(), false);
		});
	}
});

test("invalid Worker diagnostic envelopes and fences retain local failure detail", async (t) => {
	for (const fields of [{ requestId: "foreign-request" }, { sequence: 2 }, { unexpected: true }]) {
		await t.test(JSON.stringify(fields), async () => {
			const fixture = controlledLease();
			const execution = new WorkerProviderStepExecutor({ lease: fixture.lease }).execute({
				...workerInput("https://example.invalid"), requestId: "durable-request",
			});
			const rejection = assert.rejects(execution, (error: unknown) => {
				assert(error instanceof ProviderFailure);
				assert.equal(error.retryable, false);
				assert.equal(error.diagnostics.error_source, "worker_rpc");
				assert.match(error.publicDetail ?? "", /Restart mycli/u);
				return true;
			});
			fixture.deliver({ type: "provider_step_diagnostic", sequence: 1, diagnostic: null, ...fields });
			await rejection;
			assert.equal(fixture.terminated(), true);
		});
	}
});

test("new Workers keep diagnostic fields compatible with a legacy coordinator", async (t) => {
	const server = createServer((request, response) => {
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end('data: {"id":"legacy-result","choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await listen(server);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address !== "string");
	const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const lease = await pool.acquire({ priority: "interactive", source: "root", sessionId: "legacy-session", turnId: "legacy-turn" });
	const legacyFields = new Set([
		"attempt", "elapsedMs", "textDeltaIntervalCount", "providerEventCount", "reasoningEventCount",
		"textEventCount", "providerStateEventCount", "toolCallEventCount", "usageEventCount",
		"completedEventCount", "reasoningBytes", "textBytes", "success",
		"ttfbMs", "ttftMs", "tbtMs", "maxTbtMs", "failureKind", "failure",
	]);
	let diagnostics = 0;
	const unexpectedFields: string[] = [];
	const bridge = new AgentWorkerLease({
		...lease, threadId: lease.threadId, failure: lease.failure,
		release: () => lease.release(), fence: () => lease.fence(), terminate: (reason) => lease.terminate(reason),
		postMessage: (value) => {
			const command = { ...(value as Record<string, unknown>) };
			delete command.streamDiagnosticsVersion;
			lease.postMessage(command);
		},
		onMessage: (listener) => lease.onMessage((value) => {
			const frame = value as { type?: string; diagnostic?: Record<string, unknown> };
			if (frame.type === "provider_step_diagnostic") {
				diagnostics += 1;
				unexpectedFields.push(...Object.keys(frame.diagnostic ?? {}).filter((key) => !legacyFields.has(key)));
			}
			listener(value);
		}),
	});
	const result = await new WorkerProviderStepExecutor({ lease: bridge }).execute({
		...workerInput(`http://127.0.0.1:${address.port}/v1`), requestId: "legacy-request",
	});
	assert(!("failure" in result));
	assert.equal(diagnostics, 1);
	await lease.release();
	assert.deepEqual(unexpectedFields, [], "legacy coordinator rejects provider stream diagnostic fields");
});

test("settled Worker steps ignore late events and attempt proposals", async () => {
	const fixture = controlledLease();
	let effects = 0;
	const result = new WorkerProviderStepExecutor({ lease: fixture.lease }).execute({
		...workerInput("https://example.invalid"), requestId: "durable-request",
		emit: () => { effects += 1; }, recordAttempt: async () => { effects += 1; },
	});
	fixture.deliver({ type: "provider_step_result", sequence: 1, result: { failure: { code: "auth_error", message: "provider authentication failed", retryable: false }, eventsObserved: 0 } });
	await result;
	fixture.deliver({ type: "provider_step_event", sequence: 2, event: { type: "text_delta", text: "late" } });
	fixture.deliver({ type: "provider_step_attempt", sequence: 3, update: attemptUpdate(1, "started") });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(effects, 0);
});

test("coordinator rejects a successful Worker result without a committed terminal attempt", async () => {
	const fixture = controlledLease();
	const result = new WorkerProviderStepExecutor({ lease: fixture.lease }).execute({
		...workerInput("https://example.invalid"), requestId: "durable-request", recordAttempt: async () => {},
	});
	const rejection = assert.rejects(result, /committed terminal attempt/u);
	fixture.deliver({ type: "provider_step_result", sequence: 1, result: { assistantText: "uncommitted", usage: {}, toolCalls: [], webSearchCalls: [] } });
	await rejection;
	assert.equal(fixture.terminated(), true);
});

test("Worker executor carries native identity and private auth bindings without adding them to requests", async () => {
	const fixture = controlledLease();
	const apiBaseUrl = "https://example.invalid";
	const nativeTransport = {
		version: 1 as const, catalogProviderId: "openai" as const, api: "openai-completions" as const,
		modelId: "test-model", modelSource: "catalog" as const, endpointSha256: providerNativeEndpointSha256(apiBaseUrl),
	};
	const providerEnv = { OPENAI_API_KEY: "dummy-private-binding" };
	const result = new WorkerProviderStepExecutor({ lease: fixture.lease }).execute({
		...workerInput(apiBaseUrl), requestId: "durable-request",
		config: { ...config(apiBaseUrl), nativeTransport, providerEnv, allowAmbientAuth: false },
		providerRoute: { ...route(apiBaseUrl), source: "pi_ai_builtin", catalogProviderId: "openai", nativeTransport },
		request: { ...providerRequest(), nativeTransport },
	});
	const command = fixture.commands[0];
	assert(command?.type === "provider_step_execute");
	assert.deepEqual(command.config.nativeTransport, nativeTransport);
	assert.equal(command.config.homeDir, config(apiBaseUrl).homeDir);
	assert.equal(command.config.authRef, config(apiBaseUrl).authRef);
	assert.equal(command.config.allowAmbientAuth, false);
	assert.deepEqual(command.config.providerEnv, providerEnv);
	providerEnv.OPENAI_API_KEY = "changed-binding";
	assert.equal(command.config.providerEnv?.OPENAI_API_KEY, "dummy-private-binding");
	assert.doesNotMatch(JSON.stringify({ request: command.request, route: command.route }), /dummy-private-binding|providerEnv|homeDir|allowAmbientAuth/u);
	fixture.deliver({ type: "provider_step_result", sequence: 1, result: { assistantText: "done", usage: {}, toolCalls: [], webSearchCalls: [] } });
	assert(!("failure" in await result));
});

test("Worker ACK gate rejects foreign confirmations and ignores an old attempt ACK", async (t) => {
	for (const mode of ["request", "attempt", "sequence", "duplicate"] as const) {
		await t.test(mode, async (t) => {
			let requests = 0;
			const server = createServer((request, response) => {
				requests += 1;
				request.resume();
				response.writeHead(503, { "content-type": "application/json", "retry-after": "60" });
				response.end('{"error":{"type":"server_error","message":"temporarily unavailable"}}');
			});
			await listen(server);
			t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
			const address = server.address();
			assert(address && typeof address !== "string");
			const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
			const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
			t.after(async () => pool.close());
			const lease = await pool.acquire({ priority: "interactive", source: "root", sessionId: "ack-session", turnId: "ack-turn" });
			const identity = {
				protocolVersion: AGENT_WORKER_PROTOCOL_VERSION, coordinatorEpoch: lease.coordinatorEpoch,
				workerId: lease.workerId, workerGeneration: lease.workerGeneration,
				leaseId: lease.leaseId, jobId: lease.jobId, sessionId: lease.sessionId, turnId: lease.turnId,
				timelineWindowId: "window-ack", timelineVersion: 1, requestId: "durable-request",
			};
			const updates: ProviderAttemptUpdate[] = [];
			let completed = false;
			let protocolFailed = false;
			lease.onMessage((value) => {
				if (typeof value === "object" && value !== null && "type" in value && value.type === "protocol_error") {
					protocolFailed = true;
					return;
				}
				const response = parseAgentWorkerProviderResponse(value);
				if (response.type === "provider_step_attempt") updates.push(response.update);
				if (response.type === "provider_step_result") completed = true;
			});
			lease.postMessage({
				...identity, type: "provider_step_execute", sequence: 1,
				config: { provider: "openai", protocol: "chat_completions", model: "test-model", apiBaseUrl, apiKey: "test-key", supportsImages: false, maxPromptTokens: 10000 },
				route: route(apiBaseUrl), request: providerRequest(), requestMaxRetries: 1, maxRetries: 0,
				toolCallsAllowed: false, recordAttempts: true,
			});
			await waitFor(() => updates.length === 1);
			assert.equal(requests, 0);
			const ack = (sequence: number, attemptSequence: number): void => lease.postMessage({
				...identity, type: "provider_step_attempt_ack", sequence, attemptSequence,
				...(mode === "request" ? { requestId: "foreign-request" } : {}),
			});
			if (mode !== "duplicate") {
				ack(mode === "sequence" ? 4 : 2, mode === "attempt" ? 2 : 1);
				await waitFor(() => protocolFailed);
				assert.equal(requests, 0);
				await lease.terminate("test protocol failure");
				return;
			}
			ack(2, 1);
			await waitFor(() => updates.length === 2);
			assert.equal(updates[1]?.state, "failed");
			ack(3, 1);
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			assert.equal(updates.length, 2);
			assert.equal(requests, 1);
			ack(4, 2);
			await waitFor(() => updates.length === 3);
			assert.equal(updates[2]?.state, "scheduled");
			lease.postMessage({ ...identity, type: "provider_step_cancel", sequence: 5 });
			ack(6, 3);
			await waitFor(() => updates.length === 4);
			assert.equal(updates[3]?.state, "cancelled");
			ack(7, 4);
			await waitFor(() => completed);
			assert.equal(requests, 1);
			await lease.release();
		});
	}
});

test("in-process steps freeze provider overrides and honor committed policy snapshots", async () => {
	for (const committed of [false, true]) {
		const requestOverrides = { openai: 1 };
		const streamOverrides = { openai: 0 };
		let requests = 0;
		const events: RuntimeEvent[] = [];
		const request = providerRequest();
		const result = await new InProcessProviderStepExecutor().execute({
			config: { ...config("https://example.invalid"), requestMaxRetries: 100, requestMaxRetriesByProvider: requestOverrides, streamMaxRetriesByProvider: streamOverrides },
			provider: {
				stream: (value: ProviderRequest): AsyncIterable<ProviderEvent> => {
					assert.equal(value, request);
					requests += 1;
					throw new ProviderFailure({ code: "connection_error", message: "temporary", retryable: true });
				},
			},
			request,
			timelineWindowId: "window-policy",
			timelineVersion: 1,
			maxRetries: 100,
			...(committed ? { retryPolicy: { requestMaxRetries: 0, streamMaxRetries: 0 } } : {}),
			toolCallsAllowed: false,
			signal: new AbortController().signal,
			emit: (event) => events.push(event),
			sleep: async () => { requestOverrides.openai = 100; streamOverrides.openai = 100; },
		});
		assert("failure" in result);
		assert.equal(requests, committed ? 1 : 2);
		assert.equal(events.filter((event) => event.type === "stream_retrying").length, committed ? 0 : 1);
	}
});

test("large provider overrides cannot retry fatal errors or dispatch after backoff cancellation", async () => {
	for (const fatal of [true, false]) {
		let requests = 0;
		const controller = new AbortController();
		const result = await new InProcessProviderStepExecutor().execute({
			config: { ...config("https://example.invalid"), requestMaxRetriesByProvider: { openai: 100 }, streamMaxRetriesByProvider: { openai: 100 } },
			provider: {
				stream: (): AsyncIterable<ProviderEvent> => {
					requests += 1;
					throw new ProviderFailure({ code: fatal ? "auth_error" : "connection_error", message: "unavailable", retryable: !fatal });
				},
			},
			request: providerRequest(),
			timelineWindowId: "window-policy",
			timelineVersion: 1,
			maxRetries: 0,
			toolCallsAllowed: false,
			signal: controller.signal,
			emit: () => {},
			sleep: async () => { controller.abort(); },
		});
		assert("failure" in result);
		assert.equal(result.failure.code, fatal ? "auth_error" : "interrupted");
		assert.equal(requests, 1);
	}
});

test("provider stream override recovers partial output with the same logical request", async () => {
	let requests = 0;
	const request = providerRequest();
	const result = await new InProcessProviderStepExecutor().execute({
		config: { ...config("https://example.invalid"), streamMaxRetriesByProvider: { openai: 1 } },
		provider: {
			stream: async function* (value: ProviderRequest): AsyncIterable<ProviderEvent> {
				assert.equal(value, request);
				requests += 1;
				yield { type: "text_delta", text: requests === 1 ? "discarded" : "recovered" };
				if (requests === 1) throw new ProviderFailure({ code: "connection_error", message: "temporary", retryable: true });
				yield { type: "completed" };
			},
		},
		request,
		timelineWindowId: "window-policy",
		timelineVersion: 1,
		maxRetries: 0,
		toolCallsAllowed: false,
		signal: new AbortController().signal,
		emit: () => {},
		sleep: async () => {},
	});
	assert(!("failure" in result));
	assert.equal(result.assistantText, "recovered");
	assert.equal(requests, 2);
});

test("Worker steps receive resolved provider budgets and stop cancelled backoff before dispatch", async (t) => {
	let requests = 0;
	let retryAfter = "0";
	const server = createServer((request, response) => {
		requests += 1;
		request.resume();
		response.writeHead(503, { "content-type": "application/json", "retry-after": retryAfter });
		response.end(JSON.stringify({ error: { message: "temporarily unavailable", type: "server_error" } }));
	});
	await listen(server);
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert(address && typeof address !== "string");
	const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
	const pool = new AgentWorkerPool({ maxWorkers: 1, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const lease = await pool.acquire({ priority: "interactive", source: "root", sessionId: "policy-session", turnId: "policy-turn" });
	const executor = new WorkerProviderStepExecutor({ lease });
	for (const [index, mode] of ["override", "committed", "cancel"].entries()) {
		retryAfter = mode === "cancel" ? "60" : "0";
		const before = requests;
		const controller = new AbortController();
		const events: RuntimeEvent[] = [];
		const result = await executor.execute({
			config: { ...config(apiBaseUrl), requestMaxRetries: 100, requestMaxRetriesByProvider: { openai: 1 }, streamMaxRetriesByProvider: { openai: 0 } },
			provider: { stream: coordinatorProviderMustNotRun },
			providerRoute: route(apiBaseUrl),
			request: providerRequest(),
			timelineWindowId: "window-policy",
			timelineVersion: index + 1,
			maxRetries: 100,
			...(mode === "committed" ? { retryPolicy: { requestMaxRetries: 0, streamMaxRetries: 0 } } : {}),
			toolCallsAllowed: false,
			signal: controller.signal,
			emit: (event) => {
				events.push(event);
				if (mode === "cancel" && event.type === "stream_retrying") controller.abort();
			},
		});
		assert("failure" in result);
		assert.equal(requests - before, mode === "override" ? 2 : 1);
		const retry = events.find((event) => event.type === "stream_retrying");
		assert.equal(retry?.maxRetries, mode === "committed" ? undefined : 1);
		if (mode === "cancel") assert.equal(result.failure.code, "interrupted");
	}
	await lease.release();
});

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

	const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
	const result = await executor.execute({
		config: config(apiBaseUrl),
		provider: { stream: coordinatorProviderMustNotRun },
		providerRoute: route(apiBaseUrl),
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
	for (const field of ["lastTextDeltaMs", "responseTerminalMs", "sdkTerminalMs",
		"completedEventMs", "streamSettledMs", "textTailMs"] as const) {
		assert.equal(typeof diagnostics[0]?.[field], "number", field);
	}
	await lease.release();
	assert.equal(pool.snapshot().activeLeaseCount, 0);
});

test("dispatches long context and recovers local payload overflows on the same Worker lease", async (t) => {
	let requests = 0;
	let largestRequestBytes = 0;
	const server = createServer((request, response) => {
		requests += 1;
		let bytes = 0;
		request.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; });
		request.on("end", () => {
			largestRequestBytes = Math.max(largestRequestBytes, bytes);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end([
				'data: {"id":"chatcmpl-long","choices":[{"delta":{"content":"Recovered"},"finish_reason":null}]}',
				"",
				'data: {"id":"chatcmpl-long","choices":[{"delta":{},"finish_reason":"stop"}]}',
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
	const maxMessageBytes = 3 * 1024 * 1024;
	const pool = new AgentWorkerPool({ maxWorkers: 1, maxMessageBytes, idleTimeoutMs: 5_000 });
	t.after(async () => pool.close());
	const lease = await pool.acquire({ priority: "interactive", source: "root", sessionId: "long-session", turnId: "long-turn" });
	const executor = new WorkerProviderStepExecutor({ lease });
	const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
	const diagnostics: ProviderStreamDiagnostics[] = [];
	const input = {
		config: config(apiBaseUrl),
		provider: { stream: coordinatorProviderMustNotRun },
		providerRoute: route(apiBaseUrl),
		request: { ...providerRequest(), instructions: "x".repeat(2 * 1024 * 1024 + 8192) },
		timelineWindowId: "window-long",
		timelineVersion: 1,
		maxRetries: 0,
		toolCallsAllowed: false,
		signal: new AbortController().signal,
		emit: () => {},
		recordDiagnostic: (diagnostic: ProviderStreamDiagnostics) => { diagnostics.push(diagnostic); },
	};
	assert.equal("failure" in await executor.execute(input), false);
	assert.equal(requests, 1);
	assert.ok(largestRequestBytes > 2 * 1024 * 1024);
	let timelineVersion = 1;
	for (const limit of [maxMessageBytes, AGENT_WORKER_PROVIDER_RPC_MAX_BYTES]) {
		const result = await executor.execute({
			...input,
			request: { ...providerRequest(), instructions: `private-request-marker${"x".repeat(limit)}` },
			timelineVersion: ++timelineVersion,
		});
		assert("failure" in result);
		assert.equal(result.failure.code, "context_window_exceeded");
		assert.equal(result.failure.retryable, false);
		assert.equal(result.failure.diagnostics?.error_source, "worker_rpc");
		assert.equal(result.failure.diagnostics?.maximum_bytes, limit);
		assert.match(result.failure.additionalDetails ?? "", /local execution limit/u);
		assert.doesNotMatch(JSON.stringify(result), /private-request-marker/u);
		assert.equal(result.eventsObserved, 0);
		assert.equal(requests, 1);
		assert.equal(diagnostics.at(-1)?.failure?.code, "context_window_exceeded");
		assert.equal(diagnostics.at(-1)?.providerEventCount, 0);
	}
	const recovered = await executor.execute({ ...input, request: providerRequest(), timelineWindowId: "window-compacted", timelineVersion: 1 });
	assert(!("failure" in recovered));
	assert.equal(recovered.assistantText, "Recovered");
	assert.equal(requests, 2);
	assert.equal(pool.snapshot().workers[0]?.workerGeneration, lease.workerGeneration);
	await lease.release();
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
	const apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
	const executing = new WorkerProviderStepExecutor({ lease }).execute({
		errorContextVersion: 1,
		config: config(apiBaseUrl),
		provider: { stream: coordinatorProviderMustNotRun },
		providerRoute: route(apiBaseUrl),
		request: providerRequest(),
		timelineWindowId: "window-1",
		timelineVersion: 1,
		maxRetries: 0,
		toolCallsAllowed: false,
		signal: controller.signal,
		emit: (event) => events.push(event),
	});
	await waitFor(() => events.some((event) => event.type === "text_delta"));
	controller.abort(new UserTurnCancellation());

	const result = await executing;
	assert.equal("failure" in result, true);
	if (!("failure" in result)) return;
	assert.equal(result.failure.code, "interrupted");
	assert.equal(result.failure.errorContext?.reason, "runtime.user_cancelled");
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
		protocolVersion: AGENT_WORKER_PROTOCOL_VERSION,
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
				protocolVersion: AGENT_WORKER_PROTOCOL_VERSION,
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
				providerRoute: route(`http://127.0.0.1:${address.port}/v1`),
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
				protocolVersion: AGENT_WORKER_PROTOCOL_VERSION,
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

test("Worker loss retains the last acknowledged provider cause without replaying the request", async () => {
	const fixture = controlledLease();
	const cause = createErrorContext({ reason: "transport.timed_out", source: "provider",
		scope: { kind: "provider_attempt", id: "attempt:fixture" }, outcome: { state: "failed", effects: "none" },
	});
	const execution = new WorkerProviderStepExecutor({ lease: fixture.lease }).execute({
		...workerInput("https://offline.invalid"), requestId: "durable-request", errorContextVersion: 1, recordAttempt: async () => {},
	});
	const rejection = assert.rejects(execution, (error: unknown) => {
		assert.ok(error instanceof ProviderFailure);
		const failure = providerFailureToRuntimeFailure(error, { scope: { kind: "request", id: "durable-request" }, errorContextVersion: 1 });
		assert.equal(failure.errorContext?.reason, "runtime.worker_exited");
		assert.deepEqual(failure.errorContext?.outcome, { state: "unknown", effects: "possible" });
		assert.equal(failure.errorContext?.causes?.[0]?.id, cause.id);
		return true;
	});
	fixture.deliver({ type: "provider_step_attempt", sequence: 1, update: attemptUpdate(1, "started") });
	await waitFor(() => fixture.commands.length === 2);
	fixture.deliver({ type: "provider_step_attempt", sequence: 2, update: { ...attemptUpdate(2, "started"), state: "failed",
		failure: { code: "connection_error", message: "failed", retryable: false, errorContext: cause },
	} });
	await waitFor(() => fixture.commands.length === 3);
	fixture.fail();
	await rejection;
	assert.equal(fixture.commands.filter((command) => command.type === "provider_step_execute").length, 1);
});

function workerInput(apiBaseUrl: string): ProviderStepExecutionInput {
	return {
		config: config(apiBaseUrl), provider: { stream: coordinatorProviderMustNotRun },
		providerRoute: route(apiBaseUrl), request: providerRequest(),
		timelineWindowId: "window-ack", timelineVersion: 1,
		maxRetries: 0, toolCallsAllowed: false, signal: new AbortController().signal, emit: () => {},
	};
}

function attemptUpdate(sequence: number, state: "started" | "completed"): ProviderAttemptUpdate {
	return {
		sequence, attempt: 1, state, policy: { requestMaxRetries: 0, streamMaxRetries: 0 },
		requestRetriesUsed: 0, streamRetriesUsed: 0, observedAt: "2026-09-07T06:00:00.000Z",
	};
}

function controlledLease(): {
	readonly lease: AgentWorkerLease;
	readonly commands: AgentWorkerProviderCommand[];
	readonly deliver: (payload: Readonly<Record<string, unknown>>) => void;
	readonly terminated: () => boolean;
	readonly fail: () => void;
} {
	const identity = {
		coordinatorEpoch: "epoch-ack", workerId: "worker-ack", workerGeneration: 1,
		leaseId: "lease-ack", jobId: "job-ack", sessionId: "session-ack", turnId: "turn-ack",
	};
	const commands: AgentWorkerProviderCommand[] = [];
	let listener: ((message: unknown) => void) | undefined;
	let terminated = false;
	let fail!: () => void;
	const lease = new AgentWorkerLease({
		...identity, threadId: 1, source: "root", acquiredAt: "2026-09-07T06:00:00.000Z",
		failure: new Promise((resolve) => { fail = () => resolve({ code: "worker_failed", message: "fixture worker exit" }); }), release: async () => {}, fence: async () => {},
		terminate: async () => { terminated = true; },
		postMessage: (value) => { commands.push(parseAgentWorkerProviderCommand(value)); },
		onMessage: (value) => { listener = value; return () => {}; },
	});
	return {
		lease, commands, terminated: () => terminated, fail: () => fail(),
		deliver: (payload) => listener?.({
			...identity, protocolVersion: AGENT_WORKER_PROTOCOL_VERSION, requestId: "durable-request",
			timelineWindowId: "window-ack", timelineVersion: 1, ...payload,
		}),
	};
}

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
		cacheRetention: "short",
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

function route(apiBaseUrl: string) {
	return Object.freeze({
		routeId: "openai" as const,
		displayName: "OpenAI",
		supportTier: "stable" as const,
		source: "pi_ai_declared" as const,
		protocol: "chat_completions" as const,
		apiBaseUrl,
		authRef: "openai",
		activation: "active" as const,
		modelPolicy: Object.freeze({
			kind: "declared" as const,
			modelIds: Object.freeze(["test-model"]),
		}),
		snapshotVersion: 1,
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

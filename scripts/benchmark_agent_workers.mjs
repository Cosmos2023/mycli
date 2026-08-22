#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { AgentWorkerPool, WorkerProviderStepExecutor } from "@mycli/runtime";

const SCENARIOS = Object.freeze([
	"zero_workers",
	"one_idle_worker",
	"four_idle_workers",
	"one_active_worker",
	"four_active_workers",
	"large_history",
	"large_tool_output",
	"repeated_leases",
	"provider_worker_soak",
	"post_idle_recovery",
]);
const WORKER_URL = new URL("./fixtures/agent-worker-memory-benchmark.mjs", import.meta.url);
const SAMPLE_SETTLE_MS = 40;
const OPERATION_TIMEOUT_MS = 10_000;
const PROVIDER_SOAK_LEASES = 1_000;
const PROVIDER_SOAK_CHECKPOINT_INTERVAL = 25;
const PROVIDER_SOAK_WARMUP_CHECKPOINTS = 8;
const MAX_COORDINATOR_HEAP_SLOPE_BYTES = 512 * 1024;
const MAX_COORDINATOR_EXTERNAL_SLOPE_BYTES = 512 * 1024;
const MAX_WORKER_HEAP_SLOPE_BYTES = 1024 * 1024;

async function main() {
	let values;
	try {
		({ values } = parseArgs({
			options: {
				output: { type: "string" },
				scenario: { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch {
		return 64;
	}
	if (values.scenario !== undefined) {
		if (!SCENARIOS.includes(values.scenario)) return 64;
		const result = await runScenario(values.scenario);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return 0;
	}

	const results = [];
	for (const scenario of SCENARIOS) {
		results.push(await runIsolatedScenario(scenario));
	}
	const jsonl = `${results.map((result) => JSON.stringify(result)).join("\n")}\n`;
	if (values.output) await writeFile(values.output, jsonl, "utf8");
	else process.stdout.write(jsonl);
	return 0;
}

async function runIsolatedScenario(scenario) {
	const scriptPath = fileURLToPath(import.meta.url);
	const child = spawn(process.execPath, [
		...process.execArgv,
		scriptPath,
		"--scenario",
		scenario,
	], {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
	if (exitCode !== 0) {
		throw new Error(`agent_worker_memory_benchmark_child_failed:${scenario}:${stderr.length}`);
	}
	const result = JSON.parse(stdout.trim());
	if (result.scenario !== scenario || !Array.isArray(result.samples)) {
		throw new Error(`agent_worker_memory_benchmark_invalid_result:${scenario}`);
	}
	validateScenarioResult(result);
	return result;
}

async function runScenario(scenario) {
	const startedAt = performance.now();
	const baseline = await sample("baseline");
	const outcome = await scenarioOutcome(scenario);
	return Object.freeze({
		schemaVersion: 2,
		scenario,
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.versions.node,
		durationMilliseconds: Math.round(performance.now() - startedAt),
		baselineRssBytes: baseline.processRssBytes,
		peakRssDeltaBytes: Math.max(0, ...outcome.samples.map((value) => (
			value.processRssBytes - baseline.processRssBytes
		))),
		samples: Object.freeze([baseline, ...outcome.samples]),
		details: Object.freeze(outcome.details),
	});
}

async function scenarioOutcome(scenario) {
	switch (scenario) {
		case "zero_workers":
			return { samples: [await sample("zero_workers")], details: {} };
		case "one_idle_worker":
			return await idleWorkers(1);
		case "four_idle_workers":
			return await idleWorkers(4);
		case "one_active_worker":
			return await activeWorkers(1, 64 * 1024);
		case "four_active_workers":
			return await activeWorkers(4, 64 * 1024);
		case "large_history":
			return await largeHistory();
		case "large_tool_output":
			return await largeToolOutput();
		case "repeated_leases":
			return await repeatedLeases();
		case "provider_worker_soak":
			return await providerWorkerSoak();
		case "post_idle_recovery":
			return await postIdleRecovery();
		default:
			throw new Error("unknown_agent_worker_memory_benchmark_scenario");
	}
}

async function idleWorkers(count) {
	const pool = createPool({ maxWorkers: count, maxQueue: count, warmWorkers: count });
	try {
		await pool.start();
		return {
			samples: [await sample(`idle_${count}`, pool)],
			details: { configuredWorkers: count },
		};
	} finally {
		await pool.close();
	}
}

async function activeWorkers(count, payloadBytes) {
	const pool = createPool({ maxWorkers: count, maxQueue: count });
	const leases = [];
	try {
		for (let index = 0; index < count; index += 1) {
			const lease = await pool.acquire(leaseInput(`active-${index}`));
			leases.push(lease);
			await retainPayload(lease, "active", { content: "a".repeat(payloadBytes) });
		}
		return {
			samples: [await sample(`active_${count}`, pool)],
			details: { activeWorkers: count, payloadBytesPerWorker: payloadBytes },
		};
	} finally {
		await Promise.all(leases.map(async (lease) => lease.release()));
		await pool.close();
	}
}

async function largeHistory() {
	const pool = createPool({ maxWorkers: 1, maxQueue: 1 });
	let lease;
	try {
		lease = await pool.acquire(leaseInput("large-history"));
		const conversation = Array.from({ length: 300 }, (_value, index) => ({
			type: index % 2 === 0 ? "user" : "assistant",
			text: `${index}:`.padEnd(4_000, "h"),
		}));
		await retainPayload(lease, "history", { conversation });
		return {
			samples: [await sample("large_history_active", pool)],
			details: { conversationItems: conversation.length, approximatePayloadBytes: 1_200_000 },
		};
	} finally {
		await lease?.release();
		await pool.close();
	}
}

async function largeToolOutput() {
	const pool = createPool({ maxWorkers: 1, maxQueue: 1 });
	let lease;
	let completeOutput = "t".repeat(8 * 1024 * 1024);
	try {
		lease = await pool.acquire(leaseInput("large-tool-output"));
		const projection = completeOutput.slice(0, 480 * 1024);
		await retainPayload(lease, "tool_projection", {
			projection,
			artifactRef: "sha256:benchmark",
			completeBytes: Buffer.byteLength(completeOutput),
		});
		return {
			samples: [await sample("large_tool_output_active", pool)],
			details: {
				coordinatorOutputBytes: Buffer.byteLength(completeOutput),
				workerProjectionBytes: Buffer.byteLength(projection),
			},
		};
	} finally {
		completeOutput = "";
		await lease?.release();
		await pool.close();
	}
}

async function repeatedLeases() {
	const pool = createPool({ maxWorkers: 1, maxQueue: 1 });
	const generations = new Set();
	try {
		for (let index = 0; index < 120; index += 1) {
			const lease = await pool.acquire(leaseInput(`repeat-${index}`));
			generations.add(lease.workerGeneration);
			await retainPayload(lease, "repeated", { content: "r".repeat(8 * 1024) });
			await lease.release();
		}
		return {
			samples: [await sample("repeated_leases_complete", pool)],
			details: { leaseCount: 120, workerGenerationCount: generations.size },
		};
	} finally {
		await pool.close();
	}
}

async function providerWorkerSoak() {
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, {
				"content-type": "text/event-stream",
				connection: "close",
			});
			response.write('data: {"type":"response.output_text.delta","delta":"soak"}\n\n');
			response.write('data: {"type":"response.completed","response":{"id":"resp-soak","usage":{"input_tokens":16,"output_tokens":1,"total_tokens":17}}}\n\n');
			response.end("data: [DONE]\n\n");
		});
	});
	await listen(server);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("agent_worker_memory_benchmark_invalid_server_address");
	}
	const pool = new AgentWorkerPool({
		maxWorkers: 1,
		maxQueue: 1,
		warmWorkers: 1,
		idleTimeoutMs: 5_000,
	});
	const generations = new Set();
	const checkpoints = [];
	let requestCount = 0;
	server.on("request", () => { requestCount += 1; });
	try {
		await pool.start();
		for (let index = 1; index <= PROVIDER_SOAK_LEASES; index += 1) {
			const lease = await pool.acquire(leaseInput(`provider-soak-${index}`));
			generations.add(`${lease.workerId}:${lease.workerGeneration}`);
			const executor = new WorkerProviderStepExecutor({
				lease,
				createRequestId: () => `provider-soak-request-${index}`,
			});
			try {
				const result = await executor.execute({
					config: providerSoakConfig(`http://127.0.0.1:${address.port}/v1`),
					provider: { stream: coordinatorProviderMustNotRun },
					request: providerSoakRequest(index),
					timelineWindowId: "provider-soak-window",
					timelineVersion: 1,
					maxRetries: 0,
					toolCallsAllowed: false,
					signal: new globalThis.AbortController().signal,
					emit: () => undefined,
				});
				if ("failure" in result || result.assistantText !== "soak") {
					throw new Error("agent_worker_memory_benchmark_provider_step_failed");
				}
			} finally {
				await lease.release();
			}
			if (index % PROVIDER_SOAK_CHECKPOINT_INTERVAL === 0) {
				await waitFor(() => pool.snapshot().workers.some((worker) => worker.state === "idle"));
				checkpoints.push(await sample(`provider_soak_${index}`, pool));
			}
		}
		const stable = checkpoints.slice(PROVIDER_SOAK_WARMUP_CHECKPOINTS);
		const coordinatorHeapSlopeBytes = linearSlope(
			stable.map((value) => value.processHeapUsedBytes),
		);
		const coordinatorExternalSlopeBytes = linearSlope(
			stable.map((value) => value.processExternalBytes),
		);
		const workerHeapSlopeBytes = linearSlope(
			stable.map((value) => value.workerHeapUsedBytes),
		);
		await pool.close();
		const recovered = await sample("provider_soak_closed");
		return {
			samples: [...checkpoints, recovered],
			details: {
				leaseCount: PROVIDER_SOAK_LEASES,
				requestCount,
				checkpointInterval: PROVIDER_SOAK_CHECKPOINT_INTERVAL,
				checkpointCount: checkpoints.length,
				warmupCheckpointCount: PROVIDER_SOAK_WARMUP_CHECKPOINTS,
				workerGenerationCount: generations.size,
				coordinatorHeapSlopeBytes,
				coordinatorExternalSlopeBytes,
				workerHeapSlopeBytes,
				maxCoordinatorHeapSlopeBytes: MAX_COORDINATOR_HEAP_SLOPE_BYTES,
				maxCoordinatorExternalSlopeBytes: MAX_COORDINATOR_EXTERNAL_SLOPE_BYTES,
				maxWorkerHeapSlopeBytes: MAX_WORKER_HEAP_SLOPE_BYTES,
				gcAvailable: typeof globalThis.gc === "function",
			},
		};
	} finally {
		await pool.close();
		await closeServer(server);
	}
}

async function postIdleRecovery() {
	const pool = createPool({ maxWorkers: 4, maxQueue: 4, idleTimeoutMs: 100 });
	const leases = [];
	try {
		for (let index = 0; index < 4; index += 1) {
			const lease = await pool.acquire(leaseInput(`recovery-${index}`));
			leases.push(lease);
			await retainPayload(lease, "recovery", { content: "m".repeat(256 * 1024) });
		}
		const active = await sample("post_idle_peak", pool);
		await Promise.all(leases.splice(0).map(async (lease) => lease.release()));
		await waitFor(() => pool.snapshot().workerCount === 0);
		const recovered = await sample("post_idle_recovered", pool);
		return {
			samples: [active, recovered],
			details: {
				activeWorkers: 4,
				payloadBytesPerWorker: 256 * 1024,
				recoveredWorkerCount: recovered.workerCount,
			},
		};
	} finally {
		await Promise.all(leases.map(async (lease) => lease.release()));
		await pool.close();
	}
}

function createPool(options) {
	return new AgentWorkerPool({
		idleTimeoutMs: 5_000,
		workerUrl: WORKER_URL,
		...options,
	});
}

function leaseInput(id) {
	return Object.freeze({
		priority: "interactive",
		source: "root",
		sessionId: `benchmark-session-${id}`,
		turnId: `benchmark-turn-${id}`,
	});
}

async function retainPayload(lease, kind, payload) {
	let timer;
	let unsubscribe = () => undefined;
	try {
		await new Promise((resolve, reject) => {
			unsubscribe = lease.onMessage((message) => {
				if (!message || typeof message !== "object") return;
				if (message.type !== "payload_retained" || message.kind !== kind) return;
				resolve();
			});
			timer = setTimeout(
				() => reject(new Error("agent_worker_memory_benchmark_payload_timeout")),
				OPERATION_TIMEOUT_MS,
			);
			lease.postMessage({ type: "retain_payload", kind, payload });
		});
	} finally {
		if (timer) clearTimeout(timer);
		unsubscribe();
	}
}

async function sample(name, pool) {
	globalThis.gc?.();
	await delay(SAMPLE_SETTLE_MS);
	globalThis.gc?.();
	const [usage, metrics] = await Promise.all([
		Promise.resolve(process.memoryUsage()),
		pool?.metrics(),
	]);
	return Object.freeze({
		name,
		processRssBytes: usage.rss,
		processHeapUsedBytes: usage.heapUsed,
		processExternalBytes: usage.external,
		workerCount: metrics?.workerCount ?? 0,
		activeLeaseCount: metrics?.activeLeaseCount ?? 0,
		queuedCount: metrics?.queuedCount ?? 0,
		workerHeapUsedBytes: metrics?.workers.reduce((total, worker) => (
			total + (worker.heap?.usedBytes ?? 0)
		), 0) ?? 0,
		workerMessageListenerCount: metrics?.workers.reduce((total, worker) => (
			total + worker.messageListenerCount
		), 0) ?? 0,
	});
}

function linearSlope(values) {
	if (values.length < 2) return 0;
	const xMean = (values.length - 1) / 2;
	const yMean = values.reduce((total, value) => total + value, 0) / values.length;
	let numerator = 0;
	let denominator = 0;
	for (let index = 0; index < values.length; index += 1) {
		const xDelta = index - xMean;
		numerator += xDelta * (values[index] - yMean);
		denominator += xDelta * xDelta;
	}
	return Math.round(numerator / denominator);
}

function providerSoakConfig(apiBaseUrl) {
	return Object.freeze({
		provider: "openai",
		protocol: "responses",
		apiBaseUrl,
		apiKey: "benchmark-key",
	});
}

function providerSoakRequest(index) {
	return Object.freeze({
		provider: "openai",
		protocol: "responses",
		model: "benchmark-model",
		instructions: "Return the fixed benchmark response.",
		messages: Object.freeze([{
			role: "user",
			content: `${index}:`.padEnd(8 * 1024, "p"),
		}]),
		tools: Object.freeze([]),
	});
}

function coordinatorProviderMustNotRun() {
	throw new Error("agent_worker_memory_benchmark_coordinator_provider_used");
}

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function closeServer(server) {
	server.closeAllConnections?.();
	await new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
}

async function waitFor(read) {
	const deadline = Date.now() + OPERATION_TIMEOUT_MS;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("agent_worker_memory_benchmark_timeout");
		await delay(10);
	}
}

function validateScenarioResult(result) {
	if (result.schemaVersion !== 2
		|| result.platform !== process.platform
		|| result.arch !== process.arch
		|| result.nodeVersion !== process.versions.node
		|| !Number.isSafeInteger(result.durationMilliseconds)
		|| result.durationMilliseconds < 0
		|| !Number.isSafeInteger(result.peakRssDeltaBytes)
		|| result.peakRssDeltaBytes < 0) {
		throw new Error(`agent_worker_memory_benchmark_invalid_metadata:${result.scenario}`);
	}
	for (const sampleValue of result.samples) {
		for (const key of [
			"processRssBytes",
			"processHeapUsedBytes",
			"processExternalBytes",
			"workerCount",
			"activeLeaseCount",
			"queuedCount",
			"workerHeapUsedBytes",
			"workerMessageListenerCount",
		]) {
			if (!Number.isSafeInteger(sampleValue[key]) || sampleValue[key] < 0) {
				throw new Error(`agent_worker_memory_benchmark_invalid_sample:${result.scenario}:${key}`);
			}
		}
	}
	const measured = result.samples.at(-1);
	const expectedCounts = {
		zero_workers: [0, 0],
		one_idle_worker: [1, 0],
		four_idle_workers: [4, 0],
		one_active_worker: [1, 1],
		four_active_workers: [4, 4],
		large_history: [1, 1],
		large_tool_output: [1, 1],
		repeated_leases: [1, 0],
		provider_worker_soak: [0, 0],
		post_idle_recovery: [0, 0],
	}[result.scenario];
	if (!measured || !expectedCounts
		|| measured.workerCount !== expectedCounts[0]
		|| measured.activeLeaseCount !== expectedCounts[1]) {
		throw new Error(`agent_worker_memory_benchmark_invalid_counts:${result.scenario}`);
	}
	if (result.scenario === "large_tool_output"
		&& (result.details.coordinatorOutputBytes !== 8 * 1024 * 1024
			|| result.details.workerProjectionBytes !== 480 * 1024)) {
		throw new Error("agent_worker_memory_benchmark_invalid_tool_projection");
	}
	if (result.scenario === "repeated_leases"
		&& (result.details.leaseCount !== 120 || result.details.workerGenerationCount !== 2)) {
		throw new Error("agent_worker_memory_benchmark_invalid_recycling");
	}
	if (result.scenario === "provider_worker_soak") {
		const checkpoints = result.samples.filter((value) => value.name.startsWith("provider_soak_"))
			.filter((value) => value.name !== "provider_soak_closed");
		if (result.details.leaseCount !== PROVIDER_SOAK_LEASES
			|| result.details.requestCount !== PROVIDER_SOAK_LEASES
			|| result.details.checkpointCount !== checkpoints.length
			|| result.details.workerGenerationCount < 10
			|| result.details.gcAvailable !== true
			|| checkpoints.some((value) => value.workerMessageListenerCount !== 0)
			|| result.details.coordinatorHeapSlopeBytes > MAX_COORDINATOR_HEAP_SLOPE_BYTES
			|| result.details.coordinatorExternalSlopeBytes > MAX_COORDINATOR_EXTERNAL_SLOPE_BYTES
			|| result.details.workerHeapSlopeBytes > MAX_WORKER_HEAP_SLOPE_BYTES) {
			throw new Error("agent_worker_memory_benchmark_invalid_provider_soak");
		}
	}
	if (result.scenario === "post_idle_recovery"
		&& result.details.recoveredWorkerCount !== 0) {
		throw new Error("agent_worker_memory_benchmark_invalid_idle_recovery");
	}
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().then(
	(code) => { process.exitCode = code; },
	() => {
		process.stderr.write("agent_worker_memory_benchmark_failed\n");
		process.exitCode = 1;
	},
);

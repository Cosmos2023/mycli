import assert from "node:assert/strict";
import test from "node:test";
import { modelInputSha256 } from "@mycli/core";
import {
	AGENT_WORKER_MESSAGE_MAX_BYTES,
	AGENT_WORKER_PAYLOAD_MAX_BYTES,
	agentWorkerPayloadSha256,
	AgentWorkerFence,
	AgentWorkerFenceError,
	AgentWorkerProtocolError,
	parseAgentWorkerMessage,
	type ActiveAgentWorkerFence,
	type AgentWorkerMessage,
	type AgentWorkerMessagePayload,
} from "../src/index.ts";

const LOGICAL_INPUT_SHA256 = modelInputSha256({ messages: ["hello"] });
const NEXT_LOGICAL_INPUT_SHA256 = modelInputSha256({ messages: ["hello", "next"] });

const PAYLOADS: readonly AgentWorkerMessagePayload[] = [
	{ kind: "bootstrap_ready", logicalInputSha256: LOGICAL_INPUT_SHA256 },
	{
		kind: "delta_applied",
		baseVersion: 0,
		nextVersion: 1,
		logicalInputSha256: NEXT_LOGICAL_INPUT_SHA256,
	},
	{ kind: "provider_step", providerStep: 1, logicalInputSha256: LOGICAL_INPUT_SHA256 },
	{ kind: "provider_lifecycle", requestId: "request-1", state: "dispatch_started" },
	{
		kind: "tool_attempt",
		attemptId: "attempt-1",
		callId: "call-1",
		toolName: "Read",
		argumentsJson: "{\"path\":\"README.md\"}",
		mutating: false,
	},
	{
		kind: "approval_request",
		requestId: "approval-1",
		callId: "call-1",
		preview: "write README.md",
		reason: "workspace mutation",
	},
	{
		kind: "clarification_request",
		requestId: "clarification-1",
		callId: "call-1",
		question: "Which file?",
		options: ["README.md", "AGENTS.md"],
	},
	{ kind: "steering_applied", queueIds: ["queue-1", "queue-2"] },
	{ kind: "cancellation_acknowledged", reason: "user interrupt" },
	{ kind: "progress", summary: "working" },
	{ kind: "usage", usage: { input_tokens: 4, output_tokens: 2 } },
	{ kind: "terminal", status: "completed", summary: "done", usage: { total_tokens: 6 } },
];

test("parses every bounded discriminated Agent Worker message kind", () => {
	for (const payload of PAYLOADS) {
		const candidate = message(payload);
		assert.deepEqual(parseAgentWorkerMessage(candidate), candidate);
	}
});

test("rejects malformed, unknown, mismatched, and oversized messages", () => {
	const base = message({ kind: "progress", summary: "working" });
	const invalid: readonly unknown[] = [
		{ ...base, protocolVersion: 2 },
		{ ...base, messageKind: "future_message" },
		{ ...base, leaseId: "contains whitespace" },
		{ ...base, payloadSha256: "0".repeat(64) },
		{ ...base, unexpected: true },
		messageWithPayload({ kind: "usage", summary: "wrong discriminator" }),
		messageWithPayload({ kind: "progress", summary: "x", unexpected: true }),
		messageWithPayload({
			kind: "tool_attempt",
			attemptId: "attempt-1",
			callId: "call-1",
			toolName: "Read",
			argumentsJson: "not-json",
			mutating: false,
		}),
		{ ...base, oversized: "x".repeat(AGENT_WORKER_MESSAGE_MAX_BYTES) },
		messageWithPayload({
			kind: "progress",
			summary: "working",
			oversized: "x".repeat(AGENT_WORKER_PAYLOAD_MAX_BYTES),
		}),
	];

	for (const candidate of invalid) {
		assert.throws(() => parseAgentWorkerMessage(candidate), AgentWorkerProtocolError);
	}
});

test("rejects every stale fence before invoking an effect", () => {
	const active = activeFence();
	const valid = message({ kind: "progress", summary: "working" });
	const staleMessages: readonly unknown[] = [
		{ ...valid, coordinatorEpoch: "epoch-previous" },
		{ ...valid, workerId: "worker-previous" },
		{ ...valid, workerGeneration: 1 },
		{ ...valid, leaseId: "lease-previous" },
		{ ...valid, jobId: "job-previous" },
		{ ...valid, sessionId: "session-previous" },
		{ ...valid, turnId: "turn-previous" },
		{ ...valid, timelineWindowId: "window-previous" },
		{ ...valid, timelineVersion: 1 },
		{ ...valid, sequence: 2 },
		message({
			kind: "provider_step",
			providerStep: 1,
			logicalInputSha256: NEXT_LOGICAL_INPUT_SHA256,
		}),
	];

	for (const candidate of staleMessages) {
		const fence = new AgentWorkerFence(active);
		let effects = 0;
		assert.throws(() => fence.acceptEffect(candidate, () => { effects += 1; }), AgentWorkerFenceError);
		assert.equal(effects, 0);
		assert.equal(fence.snapshot().nextSequence, 1);
	}
});

test("property fuzz rejects compound-fence mutations with zero effects", () => {
	const random = xorshift32(0x51f15e);
	const fields: readonly Readonly<{
		key: keyof AgentWorkerMessage;
		mutate: (candidate: AgentWorkerMessage, iteration: number) => unknown;
	}>[] = [
		{ key: "protocolVersion", mutate: () => 2 },
		{ key: "coordinatorEpoch", mutate: (_candidate, iteration) => `epoch-stale-${iteration}` },
		{ key: "workerId", mutate: (_candidate, iteration) => `worker-stale-${iteration}` },
		{ key: "workerGeneration", mutate: (candidate) => candidate.workerGeneration + 1 },
		{ key: "leaseId", mutate: (_candidate, iteration) => `lease-stale-${iteration}` },
		{ key: "jobId", mutate: (_candidate, iteration) => `job-stale-${iteration}` },
		{ key: "sessionId", mutate: (_candidate, iteration) => `session-stale-${iteration}` },
		{ key: "turnId", mutate: (_candidate, iteration) => `turn-stale-${iteration}` },
		{ key: "timelineWindowId", mutate: (_candidate, iteration) => `window-stale-${iteration}` },
		{ key: "timelineVersion", mutate: (candidate) => candidate.timelineVersion + 1 },
		{ key: "sequence", mutate: (candidate) => candidate.sequence + 1 },
		{ key: "messageKind", mutate: () => "future_message" },
		{ key: "payloadSha256", mutate: () => "0".repeat(64) },
	];

	for (let iteration = 0; iteration < 512; iteration += 1) {
		const valid = message(PAYLOADS[Math.floor(random() * PAYLOADS.length)]!);
		const mutation = fields[Math.floor(random() * fields.length)]!;
		const candidate = { ...valid, [mutation.key]: mutation.mutate(valid, iteration) };
		const fence = new AgentWorkerFence(activeFence());
		let effects = 0;
		assert.throws(
			() => fence.acceptEffect(candidate, () => { effects += 1; }),
			(error: unknown) => (
				error instanceof AgentWorkerFenceError || error instanceof AgentWorkerProtocolError
			),
		);
		assert.equal(effects, 0);
		assert.equal(fence.snapshot().nextSequence, 1);
	}
});

test("consumes a successful effect sequence exactly once", () => {
	const fence = new AgentWorkerFence(activeFence());
	const candidate = message({ kind: "progress", summary: "working" });
	let effects = 0;

	assert.equal(fence.acceptEffect(candidate, () => { effects += 1; return "ok"; }), "ok");
	assert.throws(() => fence.acceptEffect(candidate, () => { effects += 1; }), AgentWorkerFenceError);
	assert.equal(effects, 1);
	assert.equal(fence.snapshot().nextSequence, 2);
});

test("does not make an accepted sequence replayable when its effect throws", () => {
	const fence = new AgentWorkerFence(activeFence());
	const candidate = message({ kind: "progress", summary: "working" });
	let effects = 0;

	assert.throws(() => fence.acceptEffect(candidate, () => {
		effects += 1;
		throw new Error("effect failed after starting");
	}), /effect failed/u);
	assert.throws(() => fence.acceptEffect(candidate, () => { effects += 1; }), AgentWorkerFenceError);
	assert.equal(effects, 1);
});

test("requires contiguous timeline advances", () => {
	const fence = new AgentWorkerFence(activeFence());

	assert.throws(() => fence.advanceTimeline({ baseVersion: 1, nextVersion: 2 }), AgentWorkerFenceError);
	assert.throws(() => fence.advanceTimeline({ baseVersion: 0, nextVersion: 2 }), AgentWorkerFenceError);
	assert.equal(fence.snapshot().timelineVersion, 0);

	fence.advanceTimeline({
		baseVersion: 0,
		nextVersion: 1,
		logicalInputSha256: NEXT_LOGICAL_INPUT_SHA256,
	});
	assert.equal(fence.snapshot().timelineVersion, 1);
	assert.equal(fence.snapshot().logicalInputSha256, NEXT_LOGICAL_INPUT_SHA256);
});

test("rejects the previous timeline window after ABA-safe replacement", () => {
	const fence = new AgentWorkerFence(activeFence());
	const oldWindowMessage = message({ kind: "progress", summary: "late" });

	assert.throws(() => fence.replaceTimeline({ windowId: "window-1", version: 0 }), AgentWorkerFenceError);
	fence.replaceTimeline({ windowId: "window-2", version: 0 });
	assert.equal(fence.snapshot().logicalInputSha256, undefined);

	let effects = 0;
	assert.throws(() => fence.acceptEffect(oldWindowMessage, () => { effects += 1; }), AgentWorkerFenceError);
	assert.equal(effects, 0);

	const replacementMessage = message(
		{ kind: "progress", summary: "current" },
		{ timelineWindowId: "window-2" },
	);
	assert.equal(fence.acceptEffect(replacementMessage, () => { effects += 1; return "accepted"; }), "accepted");
	assert.equal(effects, 1);
});

function activeFence(): ActiveAgentWorkerFence {
	return {
		coordinatorEpoch: "epoch-1",
		workerId: "worker-1",
		workerGeneration: 2,
		leaseId: "lease-1",
		jobId: "job-1",
		sessionId: "session-1",
		turnId: "turn-1",
		timelineWindowId: "window-1",
		timelineVersion: 0,
		nextSequence: 1,
		logicalInputSha256: LOGICAL_INPUT_SHA256,
	};
}

function message(
	payload: AgentWorkerMessagePayload,
	overrides: Partial<AgentWorkerMessage> = {},
): AgentWorkerMessage {
	return {
		protocolVersion: 1,
		coordinatorEpoch: "epoch-1",
		workerId: "worker-1",
		workerGeneration: 2,
		leaseId: "lease-1",
		jobId: "job-1",
		sessionId: "session-1",
		turnId: "turn-1",
		timelineWindowId: "window-1",
		timelineVersion: 0,
		sequence: 1,
		messageKind: payload.kind,
		payloadSha256: agentWorkerPayloadSha256(payload),
		payload,
		...overrides,
	};
}

function messageWithPayload(payload: Record<string, unknown>): unknown {
	return {
		...message({ kind: "progress", summary: "placeholder" }),
		messageKind: payload.kind,
		payloadSha256: modelInputSha256(payload),
		payload,
	};
}

function xorshift32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

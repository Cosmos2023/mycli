import assert from "node:assert/strict";
import test from "node:test";
import type { NodeRuntimeConfig } from "@mycli/config";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import type {
	CanonicalConversationItem,
	CanonicalToolCall,
	ProviderEvent,
	ProviderRequest,
	QueueSnapshot,
	QueuedInput,
	RuntimeEvent,
} from "@mycli/core";
import { ProviderFailure, type ModelProvider } from "@mycli/providers";
import type {
	AppendAssistantToolCallsInput,
	AppendToolResultInput,
	CompleteStoredTurnInput,
	FailStoredTurnInput,
	ReserveTurnInput,
	TurnStore,
	TurnReservation,
} from "@mycli/storage";
import { StorageFailure } from "@mycli/storage";
import {
	READ_TOOL_DEFINITION,
	type ToolExecutionResult,
	type ToolRouterContract,
} from "@mycli/tools";
import {
	NodeTurnRuntime,
	QueueCoordinator,
	type QueueCoordinatorStore,
} from "../src/index.ts";

test("persists and executes Read before continuing the same Responses turn", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const requests: ProviderRequest[] = [];
	const provider = scriptedProvider(trace, requests, [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "usage", usage: { input_tokens: 10, output_tokens: 2 } },
			{ type: "completed", responseId: "resp-tools-1" },
		],
		[
			{ type: "text_delta", text: "README inspected." },
			{ type: "usage", usage: { input_tokens: 5, output_tokens: 3 } },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const toolRouter = new FakeRouter(trace, successResult("call-1"));
	const instance = createRuntime({ store, provider, toolRouter });
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.deepEqual(trace, [
		"reserve",
		"provider:1",
		"persist:calls",
		"tool:call-1",
		"persist:result:call-1",
		"provider:2",
		"complete",
	]);
	assert.deepEqual(emitted.map((event) => event.type), [
		"turn_started",
		"message_complete",
		"tool_call_accepted",
		"tool_execution_started",
		"tool_execution_completed",
		"text_delta",
		"message_complete",
		"turn_completed",
	]);
	assert.equal(requests.length, 2);
	assert.equal(requests[1]?.previousResponseId, "resp-tools-1");
	assert.deepEqual(requests[1]?.items?.slice(-2), [
		{ type: "assistant_tool_calls", text: "", calls: [CALL], responseId: "resp-tools-1" },
		{ type: "tool_result", callId: "call-1", toolName: "Read", output: READ_OUTPUT, success: true },
	]);
	assert.deepEqual(result.result, {
		assistant_text: "README inspected.",
		response_id: "resp-final",
		usage: { input_tokens: 15, output_tokens: 5 },
	});
});

test("continues after a failed Read result and exposes the failure event", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools-1" },
		],
		[
			{ type: "text_delta", text: "The file was unavailable." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const failed = {
		...successResult("call-1"),
		success: false,
		modelOutput: "Read failed\nError kind: not_found",
		summary: "Failed to read README.md",
		errorKind: "not_found",
	};
	const emitted: RuntimeEvent[] = [];

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new FakeRouter(trace, failed),
	}).submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(emitted.some((event) => event.type === "tool_execution_failed"), true);
	assert.deepEqual(store.items.at(-2), {
		type: "tool_result",
		callId: "call-1",
		toolName: "Read",
		output: failed.modelOutput,
		success: false,
	});
});

test("does not misclassify an unexpected tool exception as a persistence failure", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);
	const toolRouter: ToolRouterContract = {
		execute: async () => { throw new Error("private tool detail"); },
	};

	const result = await createRuntime({ store, provider, toolRouter })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "provider_error");
	assert.deepEqual(result.result, { message: "provider request failed" });
});

test("continues beyond eight provider steps", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const steps = Array.from({ length: 9 }, (_, index): ProviderEvent[] => [
		{
			type: "tool_call",
			callId: `call-${index + 1}`,
			name: "Read",
			argumentsJson: READ_ARGUMENTS,
		},
		{ type: "completed", responseId: `resp-${index + 1}` },
	]);
	steps.push([
		{ type: "text_delta", text: "Finished after a long tool chain." },
		{ type: "completed", responseId: "resp-final" },
	]);
	const provider = scriptedProvider(trace, [], steps);
	const router = new SequencedRouter(trace);

	const result = await createRuntime({ store, provider, toolRouter: router })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(trace.filter((item) => item.startsWith("provider:")).length, 10);
	assert.equal(router.calls, 9);
});

test("executes a provider batch above sixteen calls", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const calls = Array.from({ length: 17 }, (_, index): ProviderEvent => ({
		type: "tool_call",
		callId: `call-${index + 1}`,
		name: "Read",
		argumentsJson: READ_ARGUMENTS,
	}));
	const provider = scriptedProvider(trace, [], [
		[
			...calls,
			{ type: "completed", responseId: "resp-many-tools" },
		],
		[
			{ type: "text_delta", text: "All ranges inspected." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);
	const router = new SequencedRouter(trace);

	const result = await createRuntime({ store, provider, toolRouter: router })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(router.calls, 17);
	assert.equal(trace.includes("persist:calls"), true);
});

test("rejects duplicate call IDs before persistence or execution", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "completed", responseId: "resp-duplicate" },
	]]);
	const router = new SequencedRouter(trace);

	const result = await createRuntime({ store, provider, toolRouter: router })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "tool_protocol_error");
	assert.equal(router.calls, 0);
	assert.equal(trace.includes("persist:calls"), false);
});

test("rejects a missing call ID before persistence or execution", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "", name: "Read", argumentsJson: READ_ARGUMENTS },
	]]);
	const router = new SequencedRouter(trace);

	const result = await createRuntime({ store, provider, toolRouter: router })
		.submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "tool_protocol_error");
	assert.equal(router.calls, 0);
	assert.equal(trace.includes("persist:calls"), false);
});

test("rejects provider events emitted after completion", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [[
		{ type: "completed", responseId: "resp-final" },
		{ type: "text_delta", text: "late output" },
	]]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "provider_error");
	assert.equal(trace.includes("complete"), false);
});

test("executes multiple calls sequentially in provider order", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "tool_call", callId: "call-2", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[
			{ type: "text_delta", text: "Both ranges inspected." },
			{ type: "completed", responseId: "resp-final" },
		],
	]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.deepEqual(trace, [
		"reserve",
		"provider:1",
		"persist:calls",
		"tool:call-1",
		"persist:result:call-1",
		"tool:call-2",
		"persist:result:call-2",
		"provider:2",
		"complete",
	]);
});

test("interrupts after a durable tool result without requesting a continuation", async () => {
	const trace: string[] = [];
	const controller = new AbortController();
	const store = new FakeStore(trace);
	store.afterResultPersisted = () => { controller.abort(); };
	const provider = scriptedProvider(trace, [], [[
		{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
		{ type: "completed", responseId: "resp-tools" },
	]]);

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
	}).submit(submission(), () => {}, { signal: controller.signal });

	assert.equal(result.status, "interrupted");
	assert.equal(result.error_code, "interrupted");
	assert.equal(store.items.at(-1)?.type, "tool_result");
	assert.equal(trace.filter((item) => item.startsWith("provider:")).length, 1);
});

test("applies the pre-event retry budget independently to each provider step", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	let providerAttempts = 0;
	const provider: ModelProvider = {
		stream: () => {
			providerAttempts += 1;
			trace.push(`provider:${providerAttempts}`);
			if (providerAttempts === 1 || providerAttempts === 3) {
				return failingProviderEvents(new ProviderFailure({
					code: "provider_error",
					message: "temporary provider failure",
					retryable: true,
				}));
			}
			if (providerAttempts === 2) {
				return providerEvents([
					{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
					{ type: "completed", responseId: "resp-tools" },
				]);
			}
			return providerEvents([
				{ type: "text_delta", text: "Recovered twice." },
				{ type: "completed", responseId: "resp-final" },
			]);
		},
	};
	const emitted: RuntimeEvent[] = [];

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
	}).submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(providerAttempts, 4);
	assert.equal(emitted.filter((event) => event.type === "stream_retrying").length, 2);
	assert.equal(emitted.filter((event) => event.type === "stream_recovered").length, 2);
});

test("reports bounded tool execution duration from a monotonic clock", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[{ type: "completed", responseId: "resp-final" }],
	]);
	const emitted: RuntimeEvent[] = [];

	await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		monotonicClock: numberSequence([100, 125]),
	}).submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	const completion = emitted.find((event) => event.type === "tool_execution_completed");
	assert.ok(completion);
	assert.equal("durationMs" in completion ? completion.durationMs : undefined, 25);
});

test("passes mutation metadata unchanged to durable tool-result storage", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const metadata = {
		path: "src/a.ts",
		status: "edited",
		matches: 1,
		diff: "-old\n+new\n",
		addedLines: 1,
		removedLines: 1,
		diffTruncated: false,
	};
	const provider = scriptedProvider(trace, [], [
		[
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
			{ type: "completed", responseId: "resp-tools" },
		],
		[{ type: "completed", responseId: "resp-final" }],
	]);
	const result = { ...successResult("call-1"), metadata };

	await createRuntime({
		store,
		provider,
		toolRouter: new FakeRouter(trace, result),
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.strictEqual(store.toolResults[0]?.metadata, metadata);
});

test("commits accepted steers before the next provider request", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const requests: ProviderRequest[] = [];
	let step = 0;
	const provider: ModelProvider = {
		stream: (request) => {
			requests.push(request);
			trace.push(`provider:${++step}`);
			if (step === 1) {
				queue.coordinator.enqueueSteer({
					clientTurnId: "client-steer",
					expectedTurnId: "turn-1",
					activeTurnId: "turn-1",
					steerable: true,
					text: "Also inspect package.json",
				});
				return providerEvents([
					{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
					{ type: "completed", responseId: "resp-tools" },
				]);
			}
			return providerEvents([
				{ type: "text_delta", text: "Both files inspected." },
				{ type: "completed", responseId: "resp-final" },
			]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.ok(trace.indexOf("queue:commit") < trace.indexOf("provider:2"));
	assert.deepEqual(requests[1]?.items?.at(-1), {
		type: "user",
		text: "Also inspect package.json",
	});
	assert.deepEqual(queue.committedQueueIds, ["queue-1"]);
});

test("rejects unconsumed steers before normal terminal completion", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const provider: ModelProvider = {
		stream: () => {
			queue.coordinator.enqueueSteer({
				clientTurnId: "client-steer",
				expectedTurnId: "turn-1",
				activeTurnId: "turn-1",
				steerable: true,
				text: "Too late for this request",
			});
			return providerEvents([
				{ type: "text_delta", text: "Done." },
				{ type: "completed", responseId: "resp-final" },
			]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "completed");
	assert.equal(queue.coordinator.snapshot().pendingSteers.length, 0);
	assert.equal(queue.coordinator.snapshot().rejectedSteers[0]?.kind, "rejected_steer");
	assert.ok(trace.lastIndexOf("queue:save") < trace.indexOf("complete"));
});

test("retains pending steers when a turn is interrupted", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const controller = new AbortController();
	const provider: ModelProvider = {
		stream: () => {
			queue.coordinator.enqueueSteer({
				clientTurnId: "client-steer",
				expectedTurnId: "turn-1",
				activeTurnId: "turn-1",
				steerable: true,
				text: "Keep this steer",
			});
			controller.abort();
			return providerEvents([{ type: "completed", responseId: "resp-final" }]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => {}, { signal: controller.signal });

	assert.equal(result.status, "interrupted");
	assert.equal(queue.coordinator.snapshot().pendingSteers[0]?.text, "Keep this steer");
	assert.equal(queue.coordinator.snapshot().rejectedSteers.length, 0);
});

test("does not continue the provider when committing a steer fails", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const requests: ProviderRequest[] = [];
	let step = 0;
	const provider: ModelProvider = {
		stream: (request) => {
			requests.push(request);
			step += 1;
			if (step > 1) {
				return providerEvents([
					{ type: "text_delta", text: "Continued without the steer." },
					{ type: "completed", responseId: "resp-final" },
				]);
			}
			queue.coordinator.enqueueSteer({
				clientTurnId: "client-steer",
				expectedTurnId: "turn-1",
				activeTurnId: "turn-1",
				steerable: true,
				text: "Persist me first",
			});
			queue.failCommit = true;
			return providerEvents([
				{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: READ_ARGUMENTS },
				{ type: "completed", responseId: "resp-tools" },
			]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "persistence_error");
	assert.equal(requests.length, 1);
	assert.equal(trace.includes("complete"), false);
});

test("does not report terminal success when queue rejection persistence fails", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace);
	const queue = queueFixture(store, trace);
	const provider: ModelProvider = {
		stream: () => {
			queue.coordinator.enqueueSteer({
				clientTurnId: "client-steer",
				expectedTurnId: "turn-1",
				activeTurnId: "turn-1",
				steerable: true,
				text: "Persist terminal transition",
			});
			queue.failSave = true;
			return providerEvents([
				{ type: "text_delta", text: "Done." },
				{ type: "completed", responseId: "resp-final" },
			]);
		},
	};

	const result = await createRuntime({
		store,
		provider,
		toolRouter: new SequencedRouter(trace),
		queueCoordinator: queue.coordinator,
	}).submit(submission(), () => {}, { signal: new AbortController().signal });

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "persistence_error");
	assert.equal(trace.includes("complete"), false);
});

function createRuntime(options: {
	readonly store: TurnStore;
	readonly provider: ModelProvider;
	readonly toolRouter: ToolRouterContract;
	readonly queueCoordinator?: QueueCoordinator;
	readonly monotonicClock?: () => number;
}): NodeTurnRuntime {
	return new NodeTurnRuntime({
		sessionId: "session-1",
		workspaceRoot: "/workspace",
		threadId: "session-1",
		instructions: "You are mycli.",
		store: options.store,
		resolveConfig: () => config(),
		createProvider: () => options.provider,
		createTurnId: () => "turn-1",
		clock: clockSequence(),
		sleep: async () => {},
		random: () => 0.5,
		planTools: () => [READ_TOOL_DEFINITION],
		toolRouter: options.toolRouter,
		...(options.queueCoordinator ? { queueCoordinator: options.queueCoordinator } : {}),
		...(options.monotonicClock ? { monotonicClock: options.monotonicClock } : {}),
	});
}

function queueFixture(store: FakeStore, trace: string[]) {
	let durable = emptyQueue();
	const committedQueueIds: string[] = [];
	const fixture = {
		failCommit: false,
		failSave: false,
		committedQueueIds,
		coordinator: undefined as unknown as QueueCoordinator,
	};
	const queueStore: QueueCoordinatorStore = {
		loadCommittedQueueIds: () => new Set(committedQueueIds),
		saveSnapshot: (snapshot) => {
			if (fixture.failSave) throw new StorageFailure("queue save failed");
			durable = snapshot;
			trace.push("queue:save");
		},
		commitPending: (_turnId, records) => {
			if (fixture.failCommit) throw new StorageFailure("queue commit failed");
			for (const record of records) {
				if (!committedQueueIds.includes(record.queueId)) {
					committedQueueIds.push(record.queueId);
					store.items.push({ type: "user", text: record.text });
				}
			}
			const ids = new Set(records.map((record) => record.queueId));
			durable = Object.freeze({
				...durable,
				revision: durable.revision + 1,
				pendingSteers: Object.freeze(durable.pendingSteers.filter(
					(record) => !ids.has(record.queueId),
				)),
			});
			trace.push("queue:commit");
			return durable;
		},
	};
	let nextQueueId = 0;
	fixture.coordinator = new QueueCoordinator({
		initial: durable,
		store: queueStore,
		activeTurnId: null,
		createQueueId: () => `queue-${++nextQueueId}`,
		clock: () => "2026-08-04T00:00:00.000Z",
	});
	return fixture;
}

function emptyQueue(): QueueSnapshot {
	return Object.freeze({
		sessionId: "session-1",
		revision: 0,
		pendingSteers: Object.freeze([] as QueuedInput[]),
		rejectedSteers: Object.freeze([] as QueuedInput[]),
		followUps: Object.freeze([] as QueuedInput[]),
	});
}

class FakeStore implements TurnStore {
	readonly trace: string[];
	readonly items: CanonicalConversationItem[] = [];
	readonly toolResults: AppendToolResultInput[] = [];
	turn: RuntimeTurnRecord | undefined;
	afterResultPersisted?: () => void;

	constructor(trace: string[]) {
		this.trace = trace;
	}

	reserveTurn(input: ReserveTurnInput): TurnReservation {
		this.trace.push("reserve");
		this.turn = turnRecord(input);
		this.items.push({ type: "user", text: input.userText });
		return { kind: "reserved", turn: this.turn };
	}

	loadTurn(): RuntimeTurnRecord | undefined {
		return this.turn;
	}

	loadConversation() {
		return this.items.flatMap((item) => item.type === "user" || item.type === "assistant"
			? [{ role: item.type, content: item.text }]
			: []);
	}

	loadConversationItems(): readonly CanonicalConversationItem[] {
		return this.items;
	}

	appendAssistantToolCalls(input: AppendAssistantToolCallsInput): void {
		this.trace.push("persist:calls");
		this.items.push({
			type: "assistant_tool_calls",
			text: input.assistantText,
			calls: input.calls,
			...(input.responseId ? { responseId: input.responseId } : {}),
		});
	}

	appendToolResult(input: AppendToolResultInput): void {
		this.trace.push(`persist:result:${input.result.callId}`);
		this.toolResults.push(input);
		this.items.push({ type: "tool_result", ...input.result });
		this.afterResultPersisted?.();
	}

	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord {
		this.trace.push("complete");
		assert.ok(this.turn);
		this.items.push({ type: "assistant", text: input.assistantText });
		this.turn = {
			...this.turn,
			status: "completed",
			result: {
				assistant_text: input.assistantText,
				...(input.responseId ? { response_id: input.responseId } : {}),
				usage: input.usage,
			},
			completed_at: input.completedAt,
		};
		return this.turn;
	}

	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord {
		assert.ok(this.turn);
		this.turn = {
			...this.turn,
			status: input.code === "interrupted" ? "interrupted" : "failed",
			error_code: input.code,
			result: { message: input.message },
			completed_at: input.completedAt,
		};
		return this.turn;
	}

	recoverInterruptedTurns(): number {
		return 0;
	}

	close(): void {}
}

class FakeRouter implements ToolRouterContract {
	readonly #trace: string[];
	readonly #result: ToolExecutionResult;

	constructor(trace: string[], result: ToolExecutionResult) {
		this.#trace = trace;
		this.#result = result;
	}

	async execute(call: CanonicalToolCall): Promise<ToolExecutionResult> {
		this.#trace.push(`tool:${call.callId}`);
		return { ...this.#result, callId: call.callId };
	}
}

class SequencedRouter implements ToolRouterContract {
	readonly #trace: string[];
	calls = 0;

	constructor(trace: string[]) {
		this.#trace = trace;
	}

	async execute(call: CanonicalToolCall): Promise<ToolExecutionResult> {
		this.calls += 1;
		this.#trace.push(`tool:${call.callId}`);
		return successResult(call.callId);
	}
}

function scriptedProvider(
	trace: string[],
	requests: ProviderRequest[],
	steps: readonly (readonly ProviderEvent[])[],
): ModelProvider {
	let index = 0;
	return {
		stream: (request) => {
			requests.push(request);
			trace.push(`provider:${index + 1}`);
			const events = steps[index++] ?? [];
			return providerEvents(events);
		},
	};
}

async function* providerEvents(events: readonly ProviderEvent[]): AsyncIterable<ProviderEvent> {
	for (const event of events) {
		yield event;
	}
}

function failingProviderEvents(error: Error): AsyncIterable<ProviderEvent> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
			return { next: () => Promise.reject(error) };
		},
	};
}

function successResult(callId: string): ToolExecutionResult {
	return {
		callId,
		toolName: "Read",
		success: true,
		modelOutput: READ_OUTPUT,
		summary: "Read README.md",
		metadata: { path: "README.md" },
	};
}

function submission() {
	return { clientTurnId: "client-1", message: "Read README.md" };
}

function config(): NodeRuntimeConfig {
	return {
		workspaceRoot: "/workspace",
		homeDir: "/home/test",
		provider: "openai",
		protocol: "responses",
		model: "gpt-test",
		apiBaseUrl: "https://api.openai.com/v1",
		apiKey: "test-key",
		authRef: "openai",
		sessionId: "session-1",
		sessionsDbPath: "/home/test/.mycli/sessions.db",
		maxPromptTokens: 12_000,
		requestMaxRetries: 4,
		streamMaxRetries: 5,
		reasoningEffort: "medium",
		thinkingEnabled: true,
		promptCacheKeyEnabled: true,
	};
}

function numberSequence(values: readonly number[]): () => number {
	let index = 0;
	return () => values[index++] ?? values.at(-1) ?? 0;
}

function turnRecord(input: ReserveTurnInput): RuntimeTurnRecord {
	return {
		schema_version: 1,
		session_id: input.sessionId,
		client_turn_id: input.clientTurnId,
		turn_id: input.turnId,
		request_fingerprint: input.requestFingerprint,
		status: "in_progress",
		error_code: null,
		result: null,
		started_at: input.startedAt,
		completed_at: null,
	};
}

function clockSequence(): () => string {
	let tick = 0;
	return () => `2026-08-04T00:00:0${tick++}+00:00`;
}

const READ_ARGUMENTS = "{\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}";
const READ_OUTPUT = "Read succeeded\nPath: README.md";
const CALL: CanonicalToolCall = {
	callId: "call-1",
	name: "Read",
	argumentsJson: READ_ARGUMENTS,
};

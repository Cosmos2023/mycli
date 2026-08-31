import assert from "node:assert/strict";
import test from "node:test";
import {
	NODE_RUNTIME_CONTEXT_DEFAULTS,
	type NodeRuntimeConfig,
} from "@mycli/config";
import type {
	CanonicalConversationItem,
	CanonicalMessage,
	ProviderEvent,
	ProviderRequest,
	RuntimeEvent,
} from "@mycli/core";
import { ProviderFailure, type ModelProvider } from "@mycli/providers";
import {
	StorageFailure,
	type AppendAssistantToolCallsInput,
	type AppendToolResultInput,
	type CompleteStoredTurnInput,
	type FailStoredTurnInput,
	type ReserveTurnInput,
	type TurnStore,
	type TurnReservation,
} from "@mycli/storage";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import { NodeTurnRuntime } from "../src/index.ts";

interface TurnSubmission {
	readonly clientTurnId: string;
	readonly turnId?: string;
	readonly message: string;
	readonly localImages?: readonly string[];
	readonly modelOverride?: string;
}

interface NodeTurnRuntimeOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly instructions: string;
	readonly store: TurnStore;
	readonly resolveConfig: (
		submission: TurnSubmission,
	) => NodeRuntimeConfig | Promise<NodeRuntimeConfig>;
	readonly createProvider: (config: NodeRuntimeConfig) => ModelProvider;
	readonly createTurnId: () => string;
	readonly clock: () => string;
	readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly random: () => number;
	readonly maxOutputTokens?: number;
}

test("persists before provider IO and completes in normalized event order", async () => {
	const trace: string[] = [];
	const store = new FakeStore(trace, [
		{ role: "user", content: "older" },
		{ role: "assistant", content: "history" },
	]);
	let request: ProviderRequest | undefined;
	let providerCalls = 0;
	let configCalls = 0;
	const provider: ModelProvider = {
		stream: (value) => {
			trace.push("provider.stream");
			providerCalls += 1;
			request = value;
			return providerEvents([
				{ type: "reasoning_delta", text: "checking" },
				{ type: "text_delta", text: "done" },
				{ type: "usage", usage: { input_tokens: 4, output_tokens: 1 } },
				{ type: "completed", responseId: "resp-1" },
			]);
		},
	};
	const instance = createRuntime({
		store,
		trace,
		provider,
		resolveConfig: () => {
			configCalls += 1;
			return config();
		},
	});
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit({ ...submission(), turnId: "accepted-turn" }, (event) => {
		trace.push(event.type === "turn_started" ? "turn.started" : `event.${event.type}`);
		emitted.push(event);
	}, { signal: new AbortController().signal });

	assert.deepEqual(trace.slice(0, 3), ["reserve", "turn.started", "provider.stream"]);
	assert.equal(result.status, "completed");
	assert.equal(result.turn_id, "accepted-turn");
	assert.deepEqual(emitted.map((event) => event.type), [
		"turn_started",
		"reasoning_delta",
		"text_delta",
		"message_complete",
		"provider_usage",
		"turn_completed",
	]);
	assert.deepEqual(request?.messages, [
		{ role: "user", content: "older" },
		{ role: "assistant", content: "history" },
		{ role: "user", content: "current" },
	]);
	assert.equal(providerCalls, 1);
	assert.equal(configCalls, 1);

	await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});
	assert.equal(providerCalls, 1, "duplicate client_turn_id must not call provider twice");
	assert.equal(configCalls, 1, "duplicate client_turn_id must not resolve provider config");
});

test("projects a bounded max output token limit into the provider request", async () => {
	const store = new FakeStore([]);
	let request: ProviderRequest | undefined;
	const instance = createRuntime({
		store,
		maxOutputTokens: 64,
		provider: {
			stream: (value) => {
				request = value;
				return providerEvents([{ type: "completed" }]);
			},
		},
	});

	await instance.submit(submission(), () => {}, {
		signal: new AbortController().signal,
	});

	assert.equal(request?.maxOutputTokens, 64);
});

test("retries a retryable failure before the first provider event", async () => {
	const store = new FakeStore([]);
	let calls = 0;
	const sleeps: number[] = [];
	const provider: ModelProvider = {
		stream: () => {
			calls += 1;
			return calls === 1
				? failingProviderEvents(new ProviderFailure({
					code: "rate_limited",
					message: "provider rate limit exceeded",
					retryable: true,
					retryAfterSeconds: 1.25,
				}))
				: providerEvents([
					{ type: "text_delta", text: "recovered" },
					{ type: "completed", responseId: "resp-2" },
				]);
		},
	};
	const instance = createRuntime({
		store,
		provider,
		config: config({ streamMaxRetries: 2 }),
		sleep: async (delayMs) => {
			sleeps.push(delayMs);
		},
	});
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(calls, 2);
	assert.deepEqual(sleeps, [1250]);
	assert.deepEqual(emitted.map((event) => event.type), [
		"turn_started",
		"stream_retrying",
		"text_delta",
		"message_complete",
		"stream_recovered",
		"turn_completed",
	]);
});

test("uses the configured request retry budget before stream recovery", async () => {
	const store = new FakeStore([]);
	let calls = 0;
	const provider: ModelProvider = {
		stream: () => {
			calls += 1;
			return calls === 1
				? failingProviderEvents(new ProviderFailure({
					code: "provider_error",
					message: "connection failed",
					retryable: true,
				}))
				: providerEvents([
					{ type: "text_delta", text: "recovered" },
					{ type: "completed", responseId: "resp-request-retry" },
				]);
		},
	};
	const instance = createRuntime({
		store,
		provider,
		config: config({ requestMaxRetries: 1, streamMaxRetries: 0 }),
	});
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "completed");
	assert.equal(calls, 2);
	const retry = emitted.find((event) => event.type === "stream_retrying");
	assert.deepEqual(retry, {
		type: "stream_retrying",
		attempt: 1,
		maxRetries: 1,
		delayMs: 200,
		recoveryKind: "request",
		resetOutput: false,
		failureKind: "provider_error",
		additionalDetails: "provider request failed",
	});
});

test("persists retry exhaustion after the configured retry budget", async () => {
	const store = new FakeStore([]);
	let calls = 0;
	const provider: ModelProvider = {
		stream: () => {
			calls += 1;
				return failingProviderEvents(new ProviderFailure({
					code: "provider_error",
					message: "provider request failed",
					publicDetail: "Invalid schema api_key=private-value",
					retryable: true,
				diagnostics: {
					status: 400,
					provider_error_code: "invalid_function_parameters",
				},
			}));
		},
	};
	const instance = createRuntime({
		store,
		provider,
		config: config({ streamMaxRetries: 1 }),
	});
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(calls, 2);
	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "retry_exhausted");
	assert.deepEqual(store.failedInput?.diagnostics, {
		status: 400,
		provider_error_code: "invalid_function_parameters",
	});
	assert.deepEqual(result.result, {
		message: "provider retry budget exhausted",
		additional_details: "Invalid schema api_key=[REDACTED] (status 400)",
		diagnostics: {
			status: 400,
			provider_error_code: "invalid_function_parameters",
		},
	});
	assert.equal(emitted.at(-1)?.type, "turn_failed");
});

test("interrupts during retry backoff without starting another provider attempt", async () => {
	const store = new FakeStore([]);
	const controller = new AbortController();
	let calls = 0;
	const provider: ModelProvider = {
		stream: () => {
			calls += 1;
			return failingProviderEvents(new ProviderFailure({
				code: "provider_error",
				message: "provider request failed",
				retryable: true,
			}));
		},
	};
	const instance = createRuntime({
		store,
		provider,
		config: config({ streamMaxRetries: 2 }),
		sleep: async () => {
			controller.abort();
		},
	});
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: controller.signal,
	});

	assert.equal(calls, 1);
	assert.equal(result.status, "interrupted");
	assert.equal(result.error_code, "interrupted");
	assert.equal(emitted.at(-1)?.type, "turn_interrupted");
});

test("does not replay a retryable failure after output when stream retries are disabled", async () => {
	const store = new FakeStore([]);
	let calls = 0;
	const provider: ModelProvider = {
		stream: () => {
			calls += 1;
			return textThenFailure("partial", new ProviderFailure({
				code: "provider_error",
				message: "provider request failed",
				retryable: true,
			}));
		},
	};
	const instance = createRuntime({
		store,
		provider,
		config: config({ requestMaxRetries: 0, streamMaxRetries: 0 }),
	});
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "provider_error");
	assert.equal(calls, 1);
	assert.deepEqual(store.conversation, [{ role: "user", content: "current" }]);
	assert.deepEqual(emitted.map((event) => event.type), [
		"turn_started", "text_delta", "turn_failed",
	]);
});

test("rejects provider tool calls without executing or completing assistant content", async () => {
	const store = new FakeStore([]);
	const provider: ModelProvider = {
		stream: () => providerEvents([{
			type: "tool_call",
			callId: "call-1",
			name: "Read",
			argumentsJson: "{\"path\":\"README.md\"}",
		}]),
	};
	const instance = createRuntime({ store, provider });
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "unsupported_capability");
	assert.deepEqual(store.conversation, [{ role: "user", content: "current" }]);
	assert.equal(emitted.at(-1)?.type, "turn_failed");
});

test("drops late provider deltas and completion after interruption", async () => {
	const store = new FakeStore([]);
	const controller = new AbortController();
	const provider: ModelProvider = {
		stream: () => providerEvents([
			{ type: "text_delta", text: "partial" },
			{ type: "text_delta", text: "late" },
			{ type: "completed", responseId: "late" },
		]),
	};
	const instance = createRuntime({ store, provider });
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), (event) => {
		emitted.push(event);
		if (event.type === "text_delta") {
			controller.abort();
		}
	}, { signal: controller.signal });

	assert.equal(result.status, "interrupted");
	assert.equal(result.error_code, "interrupted");
	assert.equal(store.completeCalls, 0);
	assert.deepEqual(store.conversation, [{ role: "user", content: "current" }]);
	assert.deepEqual(emitted.filter((event) => event.type === "text_delta").map(
		(event) => event.text,
	), ["partial"]);
	assert.equal(emitted.some((event) => event.type === "message_complete"), false);
	assert.equal(emitted.at(-1)?.type, "turn_interrupted");
});

test("turns final persistence failure into failure instead of reporting success", async () => {
	const store = new FakeStore([]);
	store.failCompletion = true;
	const provider: ModelProvider = {
		stream: () => providerEvents([
			{ type: "text_delta", text: "complete text" },
			{ type: "completed", responseId: "resp-3" },
		]),
	};
	const instance = createRuntime({ store, provider });
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "persistence_error");
	assert.equal(emitted.some((event) => event.type === "turn_completed"), false);
	assert.deepEqual(emitted.map((event) => event.type), [
		"turn_started", "text_delta", "message_complete", "turn_failed",
	]);
});

test("finalizes an accepted turn when canonical history cannot be loaded", async () => {
	const store = new FakeStore([]);
	store.failHistoryLoad = true;
	let providerCalls = 0;
	const provider: ModelProvider = {
		stream: () => {
			providerCalls += 1;
			return providerEvents([]);
		},
	};
	const instance = createRuntime({ store, provider });
	const emitted: RuntimeEvent[] = [];

	const result = await instance.submit(submission(), emitted.push.bind(emitted), {
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "failed");
	assert.equal(result.error_code, "persistence_error");
	assert.equal(providerCalls, 0);
	assert.deepEqual(emitted.map((event) => event.type), ["turn_started", "turn_failed"]);
});

class FakeStore implements TurnStore {
	readonly trace: string[];
	readonly conversation: CanonicalMessage[];
	turn: RuntimeTurnRecord | undefined;
	completeCalls = 0;
	failCompletion = false;
	failHistoryLoad = false;
	failedInput: FailStoredTurnInput | undefined;

	constructor(trace: string[], history: readonly CanonicalMessage[] = []) {
		this.trace = trace;
		this.conversation = [...history];
	}

	reserveTurn(input: ReserveTurnInput): TurnReservation {
		this.trace.push("reserve");
		if (this.turn) {
			return { kind: "existing", turn: this.turn };
		}
		this.turn = turnRecord(input);
		this.conversation.push({ role: "user", content: input.userText });
		return { kind: "reserved", turn: this.turn };
	}

	loadTurn(): RuntimeTurnRecord | undefined {
		return this.turn;
	}

	loadConversation(): readonly CanonicalMessage[] {
		if (this.failHistoryLoad) {
			throw new StorageFailure("history read failed");
		}
		return this.conversation;
	}

	loadConversationItems(): readonly CanonicalConversationItem[] {
		return this.loadConversation().map((message) => ({
			type: message.role,
			text: message.content,
		}));
	}

	appendAssistantToolCalls(input: AppendAssistantToolCallsInput): void {
		void input;
		throw new Error("no-tool runtime must not persist tool calls");
	}

	appendContextItem(input: Parameters<TurnStore["appendContextItem"]>[0]): void {
		void input;
		throw new Error("no-tool runtime must not persist context items");
	}

	appendToolResult(input: AppendToolResultInput): void {
		void input;
		throw new Error("no-tool runtime must not persist tool results");
	}

	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord {
		this.completeCalls += 1;
		if (this.failCompletion) {
			throw new StorageFailure("final write failed");
		}
		assert.ok(this.turn);
		this.conversation.push({ role: "assistant", content: input.assistantText });
		this.turn = {
			...this.turn,
			status: "completed",
			result: { assistant_text: input.assistantText, usage: input.usage },
			completed_at: input.completedAt,
		};
		return this.turn;
	}

	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord {
		assert.ok(this.turn);
		this.failedInput = input;
		this.turn = {
			...this.turn,
			status: input.code === "interrupted" ? "interrupted" : "failed",
			error_code: input.code,
			result: {
				message: input.message,
				...(input.additionalDetails ? { additional_details: input.additionalDetails } : {}),
				...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
			},
			completed_at: input.completedAt,
		};
		return this.turn;
	}

	recoverInterruptedTurns(): number {
		return 0;
	}

	close(): void {}
}

function createRuntime(overrides: {
	readonly store: TurnStore;
	readonly provider: ModelProvider;
	readonly trace?: string[];
	readonly config?: NodeRuntimeConfig;
	readonly resolveConfig?: NodeTurnRuntimeOptions["resolveConfig"];
	readonly sleep?: NodeTurnRuntimeOptions["sleep"];
	readonly maxOutputTokens?: NodeTurnRuntimeOptions["maxOutputTokens"];
}) {
	return new NodeTurnRuntime({
		sessionId: "session-1",
		workspaceRoot: "/workspace",
		threadId: "session-1",
		instructions: "You are mycli.",
		store: overrides.store,
		resolveConfig: overrides.resolveConfig ?? (() => overrides.config ?? config()),
		createProvider: () => overrides.provider,
		loadLocalImages: (paths) => paths.map(() => ({
			mediaType: "image/png" as const,
			data: "aW1hZ2U=",
		})),
		createTurnId: () => "turn-1",
		clock: clockSequence(),
		publishLifecycle: () => undefined,
		sleep: overrides.sleep ?? (async () => {}),
		random: () => 0.5,
		...(overrides.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: overrides.maxOutputTokens }),
	});
}

function submission(): TurnSubmission {
	return { clientTurnId: "client-1", message: "current" };
}

function config(overrides: Partial<NodeRuntimeConfig> = {}): NodeRuntimeConfig {
	return {
		...NODE_RUNTIME_CONTEXT_DEFAULTS,
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
		maxPromptTokens: 12000,
		requestMaxRetries: 4,
		streamMaxRetries: 5,
		reasoningEffort: "medium",
		thinkingEnabled: true,
		supportsImages: true,
		promptCacheKeyEnabled: true,
		...overrides,
		webSearchMode: overrides.webSearchMode ?? "live",
		requestPermissionsToolEnabled: overrides.requestPermissionsToolEnabled ?? false,
		updatesCheckOnStartup: overrides.updatesCheckOnStartup ?? true,
	};
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
	return () => `2026-08-03T00:00:0${tick++}+00:00`;
}

async function* providerEvents(events: readonly ProviderEvent[]): AsyncIterable<ProviderEvent> {
	for (const event of events) {
		yield event;
	}
}

function failingProviderEvents(error: Error): AsyncIterable<ProviderEvent> {
	return {
		[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
			return {
				next: () => Promise.reject(error),
			};
		},
	};
}

async function* textThenFailure(text: string, error: Error): AsyncIterable<ProviderEvent> {
	yield { type: "text_delta", text };
	throw error;
}

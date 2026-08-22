import assert from "node:assert/strict";
import test from "node:test";
import {
	AgentWorkerProviderRpcError,
	parseAgentWorkerProviderCommand,
	parseAgentWorkerProviderResponse,
} from "../src/index.ts";

const IDENTITY = Object.freeze({
	protocolVersion: 1 as const,
	coordinatorEpoch: "epoch-1",
	workerId: "worker-1",
	workerGeneration: 2,
	leaseId: "lease-1",
	jobId: "job-1",
	sessionId: "session-1",
	turnId: "turn-1",
	timelineWindowId: "window-1",
	timelineVersion: 3,
	requestId: "request-1",
	sequence: 1,
});

test("parses the complete provider request schema across the Worker boundary", () => {
	const command = executeCommand();

	assert.deepEqual(parseAgentWorkerProviderCommand(command), command);
});

test("rejects malformed nested provider requests before dispatch", () => {
	const base = executeCommand();
	const invalid: readonly unknown[] = [
		{ ...base, request: { ...base.request, unexpected: true } },
		{ ...base, request: { ...base.request, provider: "future-provider" } },
		{ ...base, request: { ...base.request, protocol: "responses" } },
		{ ...base, request: { ...base.request, maxOutputTokens: 0 } },
		{ ...base, request: { ...base.request, store: "no" } },
		{ ...base, request: { ...base.request, cacheControlEnabled: "yes" } },
		{ ...base, request: { ...base.request, developerInstructions: [1] } },
		{ ...base, request: { ...base.request, messages: [{ role: "system", content: "no" }] } },
		{ ...base, request: { ...base.request, tools: [{ ...base.request.tools[0], inputSchema: [] }] } },
		{
			...base,
			request: {
				...base.request,
				items: [{
					type: "assistant_tool_calls",
					text: "",
					calls: [{ callId: "call-1", name: "Read", argumentsJson: "not-json" }],
				}],
			},
		},
		{
			...base,
			request: {
				...base.request,
				items: [{
					type: "assistant",
					text: "working",
					providerState: { provider: "openai", value: [] },
				}],
			},
		},
		{
			...base,
			request: {
				...base.request,
				items: [{ type: "user", text: "look", images: [{ mediaType: "image/png", data: "%%%=" }] }],
			},
		},
	];

	for (const candidate of invalid) {
		assert.throws(() => parseAgentWorkerProviderCommand(candidate), AgentWorkerProviderRpcError);
	}
});

test("parses bounded provider success and failure results", () => {
	const success = {
		type: "provider_step_result",
		...IDENTITY,
		result: {
			assistantText: "done",
			usage: { input_tokens: 3, output_tokens: 2 },
			responseId: "response/opaque id",
			toolCalls: [{ callId: "call/opaque id", name: "Read", argumentsJson: "{}" }],
			providerState: {
				provider: "openai",
				value: { reasoning: "checked" },
				tokenEstimate: 2,
			},
		},
	} as const;
	const failure = {
		type: "provider_step_result",
		...IDENTITY,
		result: {
			failure: {
				code: "rate_limited",
				message: "provider rate limit exceeded",
				retryable: true,
				retryAfterSeconds: 1.5,
				diagnostics: { status: 429, request_id: "opaque", exhausted: false, detail: null },
			},
			eventsObserved: 0,
		},
	} as const;

	assert.deepEqual(parseAgentWorkerProviderResponse(success), success);
	assert.deepEqual(parseAgentWorkerProviderResponse(failure), failure);
});

test("rejects malformed nested provider results", () => {
	const base = {
		type: "provider_step_result",
		...IDENTITY,
		result: { assistantText: "done", usage: {}, toolCalls: [] },
	} as const;
	const invalid: readonly unknown[] = [
		{ ...base, result: { ...base.result, unexpected: true } },
		{ ...base, result: { ...base.result, usage: { total_tokens: Number.NaN } } },
		{
			...base,
			result: {
				...base.result,
				toolCalls: [{ callId: "call-1", name: "Read", argumentsJson: "[]" }],
			},
		},
		{
			...base,
			result: {
				failure: { code: "future_error", message: "failed", retryable: false },
				eventsObserved: 0,
			},
		},
		{
			...base,
			result: {
				failure: { code: "provider_error", message: "failed", retryable: false },
				eventsObserved: 0,
				assistantText: "ambiguous",
			},
		},
		{
			...base,
			result: {
				...base.result,
				providerState: { provider: "openai", value: {}, tokenEstimate: -1 },
			},
		},
	];

	for (const candidate of invalid) {
		assert.throws(() => parseAgentWorkerProviderResponse(candidate), AgentWorkerProviderRpcError);
	}
});

function executeCommand() {
	return {
		type: "provider_step_execute" as const,
		...IDENTITY,
		config: {
			provider: "openai" as const,
			protocol: "chat_completions" as const,
			apiBaseUrl: "http://127.0.0.1:43123/v1",
			apiKey: "test-key",
		},
		request: {
			provider: "openai" as const,
			protocol: "chat_completions" as const,
			model: "test-model",
			reasoningEffort: "medium" as const,
			maxOutputTokens: 512,
			store: false,
			promptCacheKey: "session-1",
			cacheControlEnabled: true,
			instructions: "You are mycli.",
			developerInstructions: ["Keep coordinator ownership."],
			messages: [
				{ role: "user" as const, content: "hello" },
				{ role: "assistant" as const, content: "working" },
			],
			items: [
				{ type: "user" as const, text: "inspect", images: [{ mediaType: "image/png" as const, data: "aW1hZ2U=" }] },
				{
					type: "assistant" as const,
					text: "working",
					providerState: { provider: "openai" as const, value: { reasoning: "checked" } },
				},
				{
					type: "assistant_tool_calls" as const,
					text: "checking",
					calls: [{ callId: "call/opaque id", name: "Read", argumentsJson: "{}" }],
					responseId: "response/opaque id",
				},
				{
					type: "context" as const,
					text: "runtime context",
					metadata: {
						kind: "runtime_context_reminder" as const,
						role: "developer" as const,
						cacheClass: "dynamic" as const,
						durability: "persistent" as const,
						scope: "turn" as const,
						sourceId: "runtime context",
						contentSha256: "a".repeat(64),
						contentLength: 15,
					},
				},
				{
					type: "tool_result" as const,
					callId: "call/opaque id",
					toolName: "Read",
					output: "done",
					success: true,
				},
			],
			tools: [{
				id: "builtin:Read",
				name: "Read",
				description: "Read a file.",
				inputSchema: { type: "object", properties: { file_path: { type: "string" } } },
			}],
			previousResponseId: "response/opaque id",
		},
		maxRetries: 2,
		toolCallsAllowed: true,
	};
}

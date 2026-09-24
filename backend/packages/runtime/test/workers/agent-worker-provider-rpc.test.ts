import assert from "node:assert/strict";
import test from "node:test";
import { createErrorContext, errorSummary } from "@mycli/contracts";
import {
	PROVIDER_IDS,
	PROVIDER_NATIVE_APIS,
	parseProviderRouteId,
	providerNativeEndpointSha256,
	providerNativeProtocol,
	toolDiscovery,
	type ProviderNativeApi,
} from "@mycli/core";
import {
	AGENT_WORKER_PROVIDER_RPC_MAX_BYTES,
	AGENT_WORKER_PROTOCOL_VERSION,
	AgentWorkerProviderRpcError,
	AgentWorkerProviderRpcSizeError,
	parseAgentWorkerProviderCommand,
	parseAgentWorkerProviderResponse,
} from "../../src/index.ts";

const IDENTITY = Object.freeze({
	protocolVersion: AGENT_WORKER_PROTOCOL_VERSION,
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

test("Worker failures preserve structured reasons and reject the previous executable protocol", () => {
	const errorContext = createErrorContext({
		reason: "capability.image_input_unsupported", source: "provider",
		scope: { kind: "provider_attempt", id: "attempt:image" },
		outcome: { state: "not_started", effects: "none" },
		details: { model: "deepseek-v4-flash", input_origin: "history" },
	});
	const response = {
		...IDENTITY, type: "provider_step_result", result: { eventsObserved: 0,
			failure: { code: "unsupported_capability", message: "old generic detail", retryable: false, errorContext },
		},
	};
	const parsed = parseAgentWorkerProviderResponse(response);
	assert(parsed.type === "provider_step_result" && "failure" in parsed.result);
	assert.deepEqual(parsed.result.failure.errorContext, errorContext);
	assert.equal(parsed.result.failure.message, errorSummary(errorContext));
	assert.throws(() => parseAgentWorkerProviderCommand({ ...executeCommand(), protocolVersion: 1 }), AgentWorkerProviderRpcError);
	const unknown = parseAgentWorkerProviderResponse({ ...response,
		result: { ...response.result, failure: { ...response.result.failure, errorContext: { ...errorContext, version: 9 } } },
	});
	assert(unknown.type === "provider_step_result" && "failure" in unknown.result);
	assert.equal(unknown.result.failure.errorContext, undefined);
	assert.equal(unknown.result.failure.diagnostics?.error_context_invalid, true);
});

test("parses the complete provider request schema across the Worker boundary", () => {
	const command = executeCommand();

	const parsed = parseAgentWorkerProviderCommand(command);
	assert.deepEqual(parsed, command);
	assert(Object.isFrozen(parsed.route));
	assert(Object.isFrozen(parsed.route.compat));
	assert(Object.isFrozen(parsed.route.modelCompat));
	assert(Object.isFrozen(parsed.route.modelCompat?.["test-model"]));
});

test("Worker requests retain validated tool-discovery load points", () => {
	const command = executeCommand();
	const tool = { id: "mcp:docs:search", name: "mcp_docs_search", description: "Search", inputSchema: { type: "object" } };
	const discovery = toolDiscovery(tool);
	const request = { ...command.request, tools: [...command.request.tools, tool], items: [...command.request.items,
		{ type: "tool_result", callId: "discovery", toolName: "tool_search", output: "Found", success: true, toolDiscoveries: [discovery] }] };
	const parsed = parseAgentWorkerProviderCommand({ ...command, request });
	assert.equal(parsed.type, "provider_step_execute");
	assert.deepEqual(parsed.request.items?.at(-1), request.items.at(-1));
});

test("extended stream diagnostics require an explicit supported version", () => {
	const legacy = executeCommand();
	assert.deepEqual(parseAgentWorkerProviderCommand(legacy), legacy);
	const current = { ...legacy, streamDiagnosticsVersion: 1 };
	assert.deepEqual(parseAgentWorkerProviderCommand(current), current);
	for (const version of [0, 2, "1", true, null, undefined]) {
		assert.throws(() => parseAgentWorkerProviderCommand({
			...legacy, streamDiagnosticsVersion: version,
		}), AgentWorkerProviderRpcError);
	}
});

test("round trips bounded attempt proposals, acknowledgements, and restored execution state", () => {
	const update = {
		sequence: 1, attempt: 1, state: "started",
		policy: { requestMaxRetries: 4, streamMaxRetries: 2 },
		requestRetriesUsed: 0, streamRetriesUsed: 0, observedAt: "2026-09-07T06:00:00.000Z",
	} as const;
	const proposal = { ...IDENTITY, type: "provider_step_attempt", update };
	const ack = { ...IDENTITY, type: "provider_step_attempt_ack", attemptSequence: 1 };
	assert.deepEqual(parseAgentWorkerProviderResponse(proposal), proposal);
	assert.deepEqual(parseAgentWorkerProviderCommand(ack), ack);
	const restored = { ...executeCommand(), recordAttempts: true, attemptState: update };
	assert.deepEqual(parseAgentWorkerProviderCommand(restored), restored);
	const parsed = parseAgentWorkerProviderResponse(proposal);
	assert(parsed.type === "provider_step_attempt");
	assert(Object.isFrozen(parsed.update.policy));
	for (const bad of [
		{ ...update, sequence: 0 },
		{ ...update, attempt: 2 },
		{ ...update, policy: { requestMaxRetries: 101, streamMaxRetries: 2 } },
		{ ...update, rawBody: "private-payload" },
	]) assert.throws(() => parseAgentWorkerProviderResponse({ ...proposal, update: bad }), AgentWorkerProviderRpcError);
	for (const bad of [
		{ ...ack, attemptSequence: 0 },
		{ ...ack, attemptSequence: 1001 },
		{ ...ack, update },
		{ ...restored, recordAttempts: false },
		{ ...restored, maxRetries: 1 },
	]) assert.throws(() => parseAgentWorkerProviderCommand(bad), AgentWorkerProviderRpcError);
});

test("native Worker snapshots bind all config, route, and request identities across supported APIs", () => {
	for (const api of PROVIDER_NATIVE_APIS) {
		const command = nativeCommand(api);
		const parsed = parseAgentWorkerProviderCommand(command);
		assert.deepEqual(parsed, command);
		assert(parsed.type === "provider_step_execute");
		assert(Object.isFrozen(parsed.config.nativeTransport));
		assert(Object.isFrozen(parsed.route.nativeTransport));
		assert(Object.isFrozen(parsed.request.nativeTransport));
		if (api === "azure-openai-responses") assert(Object.isFrozen(parsed.config.nativeTransport?.azure));
	}
	const base = nativeCommand();
	const native = base.config.nativeTransport;
	for (const command of [
		{ ...base, config: { ...base.config, nativeTransport: undefined } },
		{ ...base, route: { ...base.route, nativeTransport: undefined } },
		{ ...base, request: { ...base.request, nativeTransport: undefined } },
		{ ...base, config: { ...base.config, nativeTransport: { ...native, modelId: "other-model" } } },
		{ ...base, request: { ...base.request, nativeTransport: { ...native, catalogProviderId: "groq" } } },
		{ ...base, route: { ...base.route, catalogProviderId: "groq" } },
		{ ...base, route: { ...base.route, source: "pi_ai_declared", catalogProviderId: undefined } },
		{ ...base, config: { ...base.config, apiBaseUrl: "https://private.invalid/v1" }, route: { ...base.route, apiBaseUrl: "https://private.invalid/v1" } },
		{ ...base, request: { ...base.request, nativeTransport: { ...native, api: "future-native-api" } } },
	]) assert.throws(() => parseAgentWorkerProviderCommand(command), AgentWorkerProviderRpcError);
	const mismatchedDialect = { ...native, api: "anthropic-messages" };
	assert.throws(() => parseAgentWorkerProviderCommand({
		...base,
		config: { ...base.config, nativeTransport: mismatchedDialect },
		route: { ...base.route, nativeTransport: mismatchedDialect },
		request: { ...base.request, nativeTransport: mismatchedDialect },
	}), AgentWorkerProviderRpcError);
	assert.doesNotThrow(() => parseAgentWorkerProviderCommand({
		...base, route: { ...base.route, apiBaseUrl: `${base.route.apiBaseUrl}/` },
	}));
});

test("Worker authentication context is bounded, private, immutable, and preserves explicit credential selection", () => {
	const base = executeCommand();
	const authRef = `test-reference-${"x".repeat(300)}`;
	const providerEnv = { OPENAI_API_KEY: "private-dummy-key", _EXPLICIT_EMPTY: "" };
	const command = {
		...base,
		config: { ...base.config, homeDir: "/tmp/mycli-private-home", authRef, providerEnv, allowAmbientAuth: false },
		route: { ...base.route, authRef },
	};
	const parsed = parseAgentWorkerProviderCommand(command);
	assert(parsed.type === "provider_step_execute");
	assert.deepEqual(parsed, command);
	providerEnv.OPENAI_API_KEY = "changed-private-key";
	assert.equal(parsed.config.providerEnv?.OPENAI_API_KEY, "private-dummy-key");
	assert(Object.isFrozen(parsed.config.providerEnv));
	const explicitReference = parseAgentWorkerProviderCommand({ ...command, config: { ...command.config, authRef: "session-selected-reference" } });
	assert(explicitReference.type === "provider_step_execute");
	assert.equal(explicitReference.config.authRef, "session-selected-reference");
	assert.doesNotMatch(JSON.stringify({ request: parsed.request, route: parsed.route }), /private-dummy-key|mycli-private-home|providerEnv|allowAmbientAuth/u);
	for (const config of [
		{ ...command.config, homeDir: "private-relative-home" },
		{ ...command.config, homeDir: "/tmp/private\npath" },
		{ ...command.config, authRef: "private\nref" },
		{ ...command.config, allowAmbientAuth: "true" },
		{ ...command.config, providerEnv: { lowercase: "private-marker" } },
		{ ...command.config, providerEnv: { OPENAI_API_KEY: 123 } },
		{ ...command.config, providerEnv: { OPENAI_API_KEY: "private\0marker" } },
		{ ...command.config, providerEnv: { OPENAI_API_KEY: "x".repeat(16385) } },
		{ ...command.config, providerEnv: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`ENV_${index}`, "value"])) },
		{ ...command.config, providerEnv: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`ENV_${index}`, "x".repeat(16384)])) },
	]) {
		assert.throws(() => parseAgentWorkerProviderCommand({ ...command, config }), (error: unknown) => {
			assert(error instanceof AgentWorkerProviderRpcError);
			assert.doesNotMatch(error.message, /private-marker|private-relative-home|foreign-private-ref/u);
			return true;
		});
	}
	for (const key of ["homeDir", "providerEnv", "allowAmbientAuth", "apiKey"] as const) {
		assert.throws(() => parseAgentWorkerProviderCommand({ ...command, request: { ...command.request, [key]: command.config[key] } }));
		assert.throws(() => parseAgentWorkerProviderCommand({ ...command, route: { ...command.route, [key]: command.config[key] } }));
	}
});

test("round trips every curated provider identity across the Worker boundary", () => {
	const base = executeCommand();
	for (const provider of PROVIDER_IDS.filter((candidate) => ![
		"openai", "codex", "compatible", "qwen", "deepseek", "anthropic",
	].includes(candidate))) {
		const command = {
			...base,
			config: { ...base.config, provider },
			route: { ...base.route, routeId: provider, displayName: provider, authRef: provider },
			request: { ...base.request, provider },
		};
		assert.deepEqual(parseAgentWorkerProviderCommand(command), command);
	}
});

test("accepts long provider context beyond the former 2 MiB transport ceiling", () => {
	const base = executeCommand();
	const command = { ...base, request: { ...base.request, instructions: "x".repeat(2 * 1024 * 1024 + 8192) } };
	assert.deepEqual(parseAgentWorkerProviderCommand(command), command);
});

test("reports a typed payload overflow without exposing request content", () => {
	const base = executeCommand();
	const command = { ...base, request: { ...base.request, instructions: "private-request-marker".repeat(Math.ceil(AGENT_WORKER_PROVIDER_RPC_MAX_BYTES / 22)) } };
	assert.throws(() => parseAgentWorkerProviderCommand(command), (error: unknown) => {
		assert(error instanceof AgentWorkerProviderRpcSizeError);
		assert.equal(error.maxBytes, AGENT_WORKER_PROVIDER_RPC_MAX_BYTES);
		assert.ok(error.actualBytes > error.maxBytes);
		assert.doesNotMatch(error.message, /private-request-marker/u);
		return true;
	});
});

test("round trips a validated dynamic provider route across the Worker boundary", () => {
	const base = executeCommand();
	const command = {
		...base,
		config: { ...base.config, provider: "cloudflare-ai-gateway" },
		route: {
			...base.route,
			routeId: "cloudflare-ai-gateway",
			displayName: "Cloudflare AI Gateway",
			supportTier: "experimental",
			source: "pi_ai_builtin",
			catalogProviderId: "cloudflare-ai-gateway",
			authRef: "cloudflare-ai-gateway",
			modelPolicy: { kind: "catalog" },
		},
		request: { ...base.request, provider: "cloudflare-ai-gateway" },
	};
	assert.deepEqual(parseAgentWorkerProviderCommand(command), command);
});

test("rejects malformed nested provider requests before dispatch", () => {
	const base = executeCommand();
	const invalid: readonly unknown[] = [
		{ ...base, request: { ...base.request, unexpected: true } },
		{ ...base, request: { ...base.request, provider: "future-provider" } },
		{
			...base,
			config: { ...base.config, provider: "Cloudflare" },
			request: { ...base.request, provider: "Cloudflare" },
		},
		{
			...base,
			config: { ...base.config, provider: "cloudflare_ai" },
			request: { ...base.request, provider: "cloudflare_ai" },
		},
		{
			...base,
			config: { ...base.config, provider: `p${"a".repeat(64)}` },
			request: { ...base.request, provider: `p${"a".repeat(64)}` },
		},
		{ ...base, request: { ...base.request, protocol: "responses" } },
		{ ...base, request: { ...base.request, model: "different-model" } },
		{ ...base, request: { ...base.request, maxOutputTokens: 0 } },
		{ ...base, request: { ...base.request, store: false } },
		{ ...base, request: { ...base.request, promptCacheKey: "legacy" } },
		{ ...base, request: { ...base.request, cacheControlEnabled: true } },
		{ ...base, request: { ...base.request, cacheRetention: "forever" } },
		{ ...base, route: { ...base.route, compat: { supportsTemperature: false } } },
		{ ...base, route: { ...base.route, modelCompat: { "test-model": { thinkingFormat: "unknown" } } } },
		{ ...base, request: { ...base.request, webSearchMode: "cached" } },
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
			webSearchCalls: [{
				callId: "ws-1",
				action: { type: "search", queries: ["mycli", "mycli docs"] },
			}],
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
				additionalDetails: "upstream throttled the request (status 429)",
				retryable: true,
				retryAfterSeconds: 1.5,
				diagnostics: { status: 429, request_id: "opaque", exhausted: false, detail: null },
			},
			eventsObserved: 0,
		},
	} as const;

	assert.deepEqual(parseAgentWorkerProviderResponse(success), success);
	assert.deepEqual(parseAgentWorkerProviderResponse(failure), failure);
	const connectionFailure = {
		...failure,
		result: {
			failure: {
				code: "connection_error",
				message: "provider connection failed",
				retryable: true,
				diagnostics: {
					transport_error_code: "ECONNRESET",
					transport_error_name: "APIConnectionError",
				},
			},
			eventsObserved: 0,
		},
	} as const;
	assert.deepEqual(parseAgentWorkerProviderResponse(connectionFailure), connectionFailure);
	const sanitizedFailure = parseAgentWorkerProviderResponse({
		...failure,
		result: {
			...failure.result,
			failure: {
				...failure.result.failure,
				message: "raw local failure api_key=private-value",
				additionalDetails: "bad api_key=private-value\n at request (file:///Users/private/app.ts:1:2)",
			},
		},
	});
	assert.equal(
		sanitizedFailure.type === "provider_step_result"
			&& "failure" in sanitizedFailure.result
			? sanitizedFailure.result.failure.additionalDetails
			: undefined,
		"bad api_key=[REDACTED]",
	);
	assert.equal(
		sanitizedFailure.type === "provider_step_result"
			&& "failure" in sanitizedFailure.result
			? sanitizedFailure.result.failure.message
			: undefined,
		"provider rate limit exceeded",
	);
});

test("Worker failure diagnostics redact valid-shaped secret strings before publication", () => {
	const response = parseAgentWorkerProviderResponse({
		...IDENTITY, type: "provider_step_result",
		result: {
			failure: {
				code: "provider_error", message: "provider request failed", retryable: true,
				diagnostics: { status: 503, reason: "upstream token=private-worker-diagnostic", request_id: "request-safe" },
			},
			eventsObserved: 0,
		},
	});
	assert(response.type === "provider_step_result" && "failure" in response.result);
	assert.equal(response.result.failure.diagnostics?.reason, "upstream token=[REDACTED]");
	assert.equal(response.result.failure.diagnostics?.request_id, "request-safe");
	assert.doesNotMatch(JSON.stringify(response), /private-worker-diagnostic/u);
});

test("parses structured provider retry diagnostics", () => {
	const event = {
		type: "provider_step_event",
		...IDENTITY,
		event: {
			type: "stream_retrying",
			attempt: 2,
			maxRetries: 5,
			delayMs: 1_500,
			recoveryKind: "stream",
			resetOutput: true,
			failureKind: "response_stream_error",
			additionalDetails: "provider response stream failed",
		},
	} as const;

	assert.deepEqual(parseAgentWorkerProviderResponse(event), event);
	const sanitized = parseAgentWorkerProviderResponse({
		...event,
		event: {
			...event.event,
			additionalDetails: "stream api_key=private-value\n at request (file:///Users/private/app.ts:1:2)",
		},
	});
	assert.equal(
		sanitized.type === "provider_step_event" && sanitized.event.type === "stream_retrying"
			? sanitized.event.additionalDetails
			: undefined,
		"stream api_key=[REDACTED]",
	);
});

test("parses hosted web-search lifecycle events", () => {
	const started = {
		type: "provider_step_event",
		...IDENTITY,
		event: { type: "web_search_started", callId: "ws-1" },
	} as const;
	const completed = {
		...started,
		event: {
			type: "web_search_completed",
			call: {
				callId: "ws-1",
				action: {
					type: "find_in_page",
					url: "https://example.com/docs",
					pattern: "install",
				},
			},
		},
	} as const;

	assert.deepEqual(parseAgentWorkerProviderResponse(started), started);
	assert.deepEqual(parseAgentWorkerProviderResponse(completed), completed);
	assert.throws(() => parseAgentWorkerProviderResponse({
		...started,
		event: { ...started.event, callId: "x".repeat(257) },
	}), AgentWorkerProviderRpcError);
});

test("parses bounded provider stream diagnostic frames", () => {
	const frame = providerDiagnosticFrame();

	assert.deepEqual(parseAgentWorkerProviderResponse(frame), frame);
	for (const diagnostic of [
		{ ...frame.diagnostic, elapsedMs: -1 },
		{ ...frame.diagnostic, ttfbMs: Number.NaN },
		{ ...frame.diagnostic, textBytes: -1 },
		{ ...frame.diagnostic, failureKind: "future_error" },
		{ ...frame.diagnostic, unexpected: true },
	]) {
		assert.throws(() => parseAgentWorkerProviderResponse({
			...frame,
			diagnostic,
		}), AgentWorkerProviderRpcError);
	}
});

test("Worker timing fields round trip, stay optional, and reject invalid durations", () => {
	const frame = providerDiagnosticFrame();
	for (const field of ["lastTextDeltaMs", "responseTerminalMs", "sdkTerminalMs", "completedEventMs",
		"streamSettledMs", "terminalPersistMs", "textTailMs"] as const) {
		const timed = { ...frame, diagnostic: { ...frame.diagnostic, [field]: 25 } };
		assert.deepEqual(parseAgentWorkerProviderResponse(timed), timed);
		for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001, "private", null]) {
			assert.throws(() => parseAgentWorkerProviderResponse({
				...frame, diagnostic: { ...frame.diagnostic, [field]: value },
			}), AgentWorkerProviderRpcError);
		}
	}
	assert.deepEqual(parseAgentWorkerProviderResponse(frame), frame);
});

test("Worker diagnostics carry per-request token usage and reject unsafe values", () => {
	const frame = providerDiagnosticFrame();
	const usage = { input_tokens: 1_200, cached_tokens: 1_100, output_tokens: 40 };
	const withUsage = { ...frame, diagnostic: { ...frame.diagnostic, usage } };

	assert.deepEqual(parseAgentWorkerProviderResponse(withUsage), withUsage);
	for (const invalid of [
		{ input_tokens: -1 },
		{ input_tokens: Number.NaN },
		{ input_tokens: Number.POSITIVE_INFINITY },
		{ input_tokens: "1200" },
		{ "bad key": 1 },
	]) {
		assert.throws(() => parseAgentWorkerProviderResponse({
			...frame,
			diagnostic: { ...frame.diagnostic, usage: invalid },
		}), AgentWorkerProviderRpcError);
	}
});

test("Worker diagnostic failures retain bounded safe detail and reject inconsistent outcomes", () => {
	const frame = providerDiagnosticFrame();
	frame.diagnostic.success = false;
	const failure = {
		code: "provider_error", message: "provider request failed", retryable: true,
		additionalDetails: "upstream request failed token=private-value", retryAfterSeconds: 2,
		diagnostics: { status: 200, error_source: "response_stream", provider_error_code: "server_error" },
	};
	const result = parseAgentWorkerProviderResponse({ ...frame, diagnostic: { ...frame.diagnostic, failure } });
	assert.equal(result.type, "provider_step_diagnostic");
	if (result.type !== "provider_step_diagnostic") return;
	assert.deepEqual(result.diagnostic.failure, { ...failure, additionalDetails: "upstream request failed token=[REDACTED]" });
	for (const diagnostic of [
		{ ...frame.diagnostic, failure, success: true },
		{ ...frame.diagnostic, failure, failureKind: "auth_error" },
		{ ...frame.diagnostic, failure: { ...failure, retryable: "true" } },
		{ ...frame.diagnostic, failure: { ...failure, retryAfterSeconds: 3_601 } },
		{ ...frame.diagnostic, failure: { ...failure, rawBody: "private" } },
	]) assert.throws(() => parseAgentWorkerProviderResponse({ ...frame, diagnostic }));
});

test("rejects malformed nested provider results", () => {
	const base = {
		type: "provider_step_result",
		...IDENTITY,
		result: { assistantText: "done", usage: {}, toolCalls: [], webSearchCalls: [] },
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
		{
			...base,
			result: {
				failure: {
					code: "provider_error",
					message: "provider request failed",
					additionalDetails: "x".repeat(2_049),
					retryable: false,
				},
				eventsObserved: 0,
			},
		},
	];

	for (const candidate of invalid) {
		assert.throws(() => parseAgentWorkerProviderResponse(candidate), AgentWorkerProviderRpcError);
	}
});

function nativeCommand(api: ProviderNativeApi = "openai-completions") {
	const base = executeCommand();
	const protocol = providerNativeProtocol(api);
	const provider = parseProviderRouteId(api === "azure-openai-responses" ? "azure-openai-responses" : api === "anthropic-messages" ? "anthropic" : "openai");
	const nativeTransport = {
		version: 1 as const, catalogProviderId: provider, api, modelId: base.config.model, modelSource: "catalog" as const,
		endpointSha256: providerNativeEndpointSha256(base.config.apiBaseUrl),
		...(api === "azure-openai-responses" ? { azure: { apiVersion: "2025-04-01-preview", deploymentName: "unit-model" } } : {}),
	};
	return {
		...base,
		config: { ...base.config, provider, protocol, nativeTransport },
		route: {
			routeId: provider, displayName: "Native test route", supportTier: "experimental" as const,
			source: "pi_ai_builtin" as const, catalogProviderId: provider, protocol,
			apiBaseUrl: base.config.apiBaseUrl, authRef: "native-auth", activation: "active" as const,
			modelPolicy: { kind: "catalog" as const }, snapshotVersion: 1, nativeTransport,
		},
		request: { ...base.request, provider, protocol, nativeTransport },
	};
}

function executeCommand() {
	return {
		type: "provider_step_execute" as const,
		...IDENTITY,
		config: {
			provider: "openai" as const,
			protocol: "chat_completions" as const,
			model: "test-model",
			apiBaseUrl: "http://127.0.0.1:43123/v1",
			apiKey: "test-key",
			supportsImages: true,
			maxPromptTokens: 12_000,
			modelContextWindowTokens: 16_000,
			maxOutputTokens: 512,
		},
		route: {
			routeId: "openai" as const,
			displayName: "OpenAI",
			supportTier: "stable" as const,
			source: "pi_ai_declared" as const,
			protocol: "chat_completions" as const,
			apiBaseUrl: "http://127.0.0.1:43123/v1",
			authRef: "openai",
			activation: "active" as const,
			modelPolicy: {
				kind: "declared" as const,
				modelIds: ["test-model"],
			},
			compat: {
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens" as const,
			},
			modelCompat: {
				"test-model": {
					supportsDeveloperRole: true,
					maxTokensField: "max_completion_tokens" as const,
				},
			},
			snapshotVersion: 1,
		},
		request: {
			provider: "openai" as const,
			protocol: "chat_completions" as const,
			model: "test-model",
				reasoningEffort: "medium" as const,
				maxOutputTokens: 512,
				sessionId: "session-1",
				cacheRetention: "long" as const,
			webSearchMode: "disabled" as const,
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
					images: [{ mediaType: "image/png" as const, data: "aW1hZ2U=", detail: "original" as const }],
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
		requestMaxRetries: 4,
		maxRetries: 2,
		toolCallsAllowed: true,
	};
}

function providerDiagnosticFrame() {
	return {
		type: "provider_step_diagnostic" as const,
		...IDENTITY,
		diagnostic: {
			attempt: 1,
			elapsedMs: 25,
			ttfbMs: 5,
			ttftMs: 10,
			tbtMs: 3,
			maxTbtMs: 4,
			textDeltaIntervalCount: 2,
			providerEventCount: 3,
			reasoningEventCount: 1,
			textEventCount: 1,
			providerStateEventCount: 0,
			toolCallEventCount: 0,
			usageEventCount: 0,
			completedEventCount: 1,
			reasoningBytes: 4,
			textBytes: 4,
			success: true,
			failureKind: "provider_error" as const,
		},
	};
}

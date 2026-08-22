import { stableModelInputJson } from "@mycli/core";
import type {
	CanonicalContextMetadata,
	CanonicalConversationItem,
	CanonicalImage,
	CanonicalMessage,
	CanonicalToolCall,
	ProviderId,
	ProviderReplayState,
	ProviderRequest,
	ProviderUsage,
	ProtocolId,
	RuntimeErrorCode,
	RuntimeEvent,
	ToolDefinition,
} from "@mycli/core";
import type {
	ProviderAgentLoopFailure,
	ProviderAgentLoopResult,
} from "./provider-agent-loop.ts";
import { AGENT_WORKER_PROTOCOL_VERSION } from "./agent-worker-protocol.ts";

export const AGENT_WORKER_PROVIDER_RPC_MAX_BYTES = 2 * 1024 * 1024;

const IDENTITY_MAX_CHARS = 256;
const API_KEY_MAX_CHARS = 16 * 1024;
const URL_MAX_CHARS = 2 * 1024;
const TEXT_MAX_CHARS = AGENT_WORKER_PROVIDER_RPC_MAX_BYTES;
const LIST_MAX_ITEMS = 4_096;
const RECORD_MAX_KEYS = 4_096;
const JSON_MAX_DEPTH = 64;
const USAGE_MAX_KEYS = 64;
const DIAGNOSTIC_MAX_KEYS = 64;
const DIAGNOSTIC_VALUE_MAX_CHARS = 2 * 1024;
const CONTEXT_TEXT_MAX_CHARS = 128 * 1024;
const CONTEXT_CONTENT_MAX_CHARS = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

const PROVIDERS = [
	"openai", "codex", "compatible", "qwen", "deepseek", "anthropic",
] as const;
const PROTOCOLS = [
	"responses", "chat_completions", "anthropic_messages",
] as const;
const RUNTIME_ERROR_CODES = [
	"config_error",
	"auth_error",
	"provider_error",
	"rate_limited",
	"context_window_exceeded",
	"retry_exhausted",
	"persistence_error",
	"interrupted",
	"unsupported_capability",
	"tool_budget_exceeded",
	"tool_protocol_error",
] as const satisfies readonly RuntimeErrorCode[];

export interface AgentWorkerProviderTransportConfig {
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly apiBaseUrl: string;
	readonly apiKey?: string;
}

interface AgentWorkerProviderRpcIdentity {
	readonly protocolVersion: typeof AGENT_WORKER_PROTOCOL_VERSION;
	readonly coordinatorEpoch: string;
	readonly workerId: string;
	readonly workerGeneration: number;
	readonly leaseId: string;
	readonly jobId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly timelineWindowId: string;
	readonly timelineVersion: number;
	readonly requestId: string;
	readonly sequence: number;
}

export type AgentWorkerProviderCommand =
	| (AgentWorkerProviderRpcIdentity & {
		readonly type: "provider_step_execute";
		readonly config: AgentWorkerProviderTransportConfig;
		readonly request: ProviderRequest;
		readonly maxRetries: number;
		readonly toolCallsAllowed: boolean;
	})
	| (AgentWorkerProviderRpcIdentity & {
		readonly type: "provider_step_cancel";
	});

export type AgentWorkerProviderResponse = AgentWorkerProviderRpcIdentity & (
	| { readonly type: "provider_step_event"; readonly event: RuntimeEvent }
	| { readonly type: "provider_step_result"; readonly result: ProviderAgentLoopResult }
);

export class AgentWorkerProviderRpcError extends Error {
	readonly code = "agent_worker_provider_rpc_error" as const;

	constructor(message: string) {
		super(`agent_worker_provider_rpc_error: ${message}`);
		this.name = "AgentWorkerProviderRpcError";
	}
}

export function parseAgentWorkerProviderCommand(value: unknown): AgentWorkerProviderCommand {
	const record = boundedRecord(value, "provider command");
	const identity = parseIdentity(record);
	if (record.type === "provider_step_cancel") {
		assertExactKeys(record, [
			"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
			"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
			"timelineVersion", "requestId", "sequence",
		], "provider cancellation");
		return Object.freeze({ type: record.type, ...identity });
	}
	if (record.type !== "provider_step_execute") throw invalid("provider command type is invalid");
	assertExactKeys(record, [
		"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
		"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
		"timelineVersion", "requestId", "sequence", "config", "request", "maxRetries",
		"toolCallsAllowed",
	], "provider execution");
	const config = parseTransportConfig(record.config);
	const request = parseProviderRequest(record.request);
	if (request.provider !== config.provider || request.protocol !== config.protocol) {
		throw invalid("provider request does not match transport config");
	}
	return Object.freeze({
		type: record.type,
		...identity,
		config,
		request,
		maxRetries: boundedInteger(record.maxRetries, "provider retries", 0, 100),
		toolCallsAllowed: booleanValue(record.toolCallsAllowed, "tool-call flag"),
	});
}

export function parseAgentWorkerProviderResponse(value: unknown): AgentWorkerProviderResponse {
	const record = boundedRecord(value, "provider response");
	const identity = parseIdentity(record);
	if (record.type === "provider_step_event") {
		assertExactKeys(record, [
			"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
			"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
			"timelineVersion", "requestId", "sequence", "event",
		], "provider event");
		return Object.freeze({
			type: record.type,
			...identity,
			event: parseRuntimeEvent(record.event),
		});
	}
	if (record.type !== "provider_step_result") throw invalid("provider response type is invalid");
	assertExactKeys(record, [
		"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
		"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
		"timelineVersion", "requestId", "sequence", "result",
	], "provider result");
	return Object.freeze({
		type: record.type,
		...identity,
		result: parseProviderResult(record.result),
	});
}

function parseIdentity(record: Readonly<Record<string, unknown>>): AgentWorkerProviderRpcIdentity {
	return Object.freeze({
		protocolVersion: protocolVersion(record.protocolVersion),
		coordinatorEpoch: identity(record.coordinatorEpoch, "coordinator epoch"),
		workerId: identity(record.workerId, "worker"),
		workerGeneration: boundedInteger(record.workerGeneration, "worker generation", 1),
		leaseId: identity(record.leaseId, "lease"),
		jobId: identity(record.jobId, "job"),
		sessionId: identity(record.sessionId, "session"),
		turnId: identity(record.turnId, "turn"),
		timelineWindowId: identity(record.timelineWindowId, "timeline window"),
		timelineVersion: boundedInteger(record.timelineVersion, "timeline version", 1),
		requestId: identity(record.requestId, "provider request"),
		sequence: boundedInteger(record.sequence, "provider sequence", 1),
	});
}

function protocolVersion(value: unknown): typeof AGENT_WORKER_PROTOCOL_VERSION {
	if (value !== AGENT_WORKER_PROTOCOL_VERSION) throw invalid("provider protocol version is invalid");
	return AGENT_WORKER_PROTOCOL_VERSION;
}

function parseTransportConfig(value: unknown): AgentWorkerProviderTransportConfig {
	const config = boundedRecord(value, "provider transport config");
	const keys = ["provider", "protocol", "apiBaseUrl"];
	if (config.apiKey !== undefined) keys.push("apiKey");
	assertExactKeys(config, keys, "provider transport config");
	const provider = oneOf(config.provider, PROVIDERS, "provider");
	const protocol = oneOf(config.protocol, PROTOCOLS, "provider protocol");
	const apiBaseUrl = boundedString(config.apiBaseUrl, "provider base URL", URL_MAX_CHARS);
	try {
		new URL(apiBaseUrl);
	} catch {
		throw invalid("provider base URL is invalid");
	}
	return Object.freeze({
		provider,
		protocol,
		apiBaseUrl,
		...(config.apiKey === undefined
			? {}
			: { apiKey: boundedString(config.apiKey, "provider API key", API_KEY_MAX_CHARS) }),
	});
}

function parseProviderRequest(value: unknown): ProviderRequest {
	const request = boundedRecord(value, "provider request");
	assertObjectShape(request,
		["provider", "protocol", "model", "instructions", "messages", "tools"],
		[
			"reasoningEffort", "maxOutputTokens", "store", "promptCacheKey", "cacheControlEnabled",
			"developerInstructions", "items", "previousResponseId",
		],
		"provider request");
	return Object.freeze({
		provider: oneOf(request.provider, PROVIDERS, "request provider"),
		protocol: oneOf(request.protocol, PROTOCOLS, "request protocol"),
		model: boundedString(request.model, "provider model", IDENTITY_MAX_CHARS),
		instructions: boundedText(request.instructions, "provider instructions", TEXT_MAX_CHARS),
		messages: boundedArray(request.messages, "provider messages", parseCanonicalMessage),
		tools: boundedArray(request.tools, "provider tools", parseToolDefinition),
		...(hasOwn(request, "reasoningEffort") ? {
				reasoningEffort: oneOf(request.reasoningEffort,
					["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const,
				"reasoning effort"),
		} : {}),
		...(hasOwn(request, "maxOutputTokens") ? {
			maxOutputTokens: boundedInteger(request.maxOutputTokens, "maximum output tokens", 1),
		} : {}),
		...(hasOwn(request, "store") ? {
			store: booleanValue(request.store, "provider storage flag"),
		} : {}),
		...(hasOwn(request, "promptCacheKey") ? {
			promptCacheKey: boundedString(request.promptCacheKey, "prompt cache key", IDENTITY_MAX_CHARS),
		} : {}),
		...(hasOwn(request, "cacheControlEnabled") ? {
			cacheControlEnabled: booleanValue(request.cacheControlEnabled, "cache-control flag"),
		} : {}),
		...(hasOwn(request, "developerInstructions") ? {
			developerInstructions: boundedArray(
				request.developerInstructions,
				"developer instructions",
				(item) => boundedText(item, "developer instruction", TEXT_MAX_CHARS),
			),
		} : {}),
		...(hasOwn(request, "items") ? {
			items: boundedArray(request.items, "provider items", parseConversationItem),
		} : {}),
		...(hasOwn(request, "previousResponseId") ? {
			previousResponseId: boundedString(
				request.previousResponseId,
				"previous provider response",
				IDENTITY_MAX_CHARS,
			),
		} : {}),
	});
}

function parseCanonicalMessage(value: unknown): CanonicalMessage {
	const message = boundedRecord(value, "provider message");
	assertExactKeys(message, ["role", "content"], "provider message");
	return Object.freeze({
		role: oneOf(message.role, ["user", "assistant"] as const, "provider message role"),
		content: boundedText(message.content, "provider message content", TEXT_MAX_CHARS),
	});
}

function parseToolDefinition(value: unknown): ToolDefinition {
	const tool = boundedRecord(value, "provider tool");
	assertExactKeys(tool, ["id", "name", "description", "inputSchema"], "provider tool");
	return Object.freeze({
		id: boundedString(tool.id, "provider tool id", IDENTITY_MAX_CHARS),
		name: boundedString(tool.name, "provider tool name", IDENTITY_MAX_CHARS),
		description: boundedText(tool.description, "provider tool description", TEXT_MAX_CHARS),
		inputSchema: jsonRecord(tool.inputSchema, "provider tool schema"),
	});
}

function parseConversationItem(value: unknown): CanonicalConversationItem {
	const item = boundedRecord(value, "provider conversation item");
	switch (item.type) {
		case "user":
			assertObjectShape(item, ["type", "text"], ["images"], "provider user item");
			return Object.freeze({
				type: item.type,
				text: boundedText(item.text, "provider user text", TEXT_MAX_CHARS),
				...(hasOwn(item, "images") ? {
					images: boundedArray(item.images, "provider images", parseCanonicalImage),
				} : {}),
			});
		case "assistant":
			assertObjectShape(item, ["type", "text"], ["providerState"], "provider assistant item");
			return Object.freeze({
				type: item.type,
				text: boundedText(item.text, "provider assistant text", TEXT_MAX_CHARS),
				...(hasOwn(item, "providerState") ? {
					providerState: parseProviderReplayState(item.providerState),
				} : {}),
			});
		case "assistant_tool_calls":
			assertObjectShape(item,
				["type", "text", "calls"],
				["responseId", "providerState"],
				"provider assistant tool item");
			return Object.freeze({
				type: item.type,
				text: boundedText(item.text, "provider assistant tool text", TEXT_MAX_CHARS),
				calls: boundedArray(item.calls, "provider tool calls", parseCanonicalToolCall),
				...(hasOwn(item, "responseId") ? {
					responseId: boundedString(
						item.responseId,
						"provider tool response",
						IDENTITY_MAX_CHARS,
					),
				} : {}),
				...(hasOwn(item, "providerState") ? {
					providerState: parseProviderReplayState(item.providerState),
				} : {}),
			});
		case "context":
			assertExactKeys(item, ["type", "text", "metadata"], "provider context item");
			return Object.freeze({
				type: item.type,
				text: boundedText(item.text, "provider context text", CONTEXT_TEXT_MAX_CHARS),
				metadata: parseContextMetadata(item.metadata),
			});
		case "tool_result":
			assertExactKeys(item,
				["type", "callId", "toolName", "output", "success"],
				"provider tool result item");
			return Object.freeze({
				type: item.type,
				callId: boundedString(item.callId, "provider tool result call", IDENTITY_MAX_CHARS),
				toolName: boundedString(item.toolName, "provider tool result name", IDENTITY_MAX_CHARS),
				output: boundedText(item.output, "provider tool result output", TEXT_MAX_CHARS),
				success: booleanValue(item.success, "provider tool result success"),
			});
		default:
			throw invalid("provider conversation item type is invalid");
	}
}

function parseCanonicalImage(value: unknown): CanonicalImage {
	const image = boundedRecord(value, "provider image");
	assertExactKeys(image, ["mediaType", "data"], "provider image");
	const data = boundedString(image.data, "provider image data", TEXT_MAX_CHARS);
	if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
		throw invalid("provider image data is invalid");
	}
	return Object.freeze({
		mediaType: oneOf(image.mediaType,
			["image/jpeg", "image/png", "image/gif", "image/webp"] as const,
			"provider image media type"),
		data,
	});
}

function parseCanonicalToolCall(value: unknown): CanonicalToolCall {
	const call = boundedRecord(value, "provider tool call");
	assertExactKeys(call, ["callId", "name", "argumentsJson"], "provider tool call");
	const argumentsJson = boundedString(
		call.argumentsJson,
		"provider tool arguments",
		TEXT_MAX_CHARS,
	);
	parseJsonObjectString(argumentsJson, "provider tool arguments");
	return Object.freeze({
		callId: boundedString(call.callId, "provider tool call", IDENTITY_MAX_CHARS),
		name: boundedString(call.name, "provider tool call name", IDENTITY_MAX_CHARS),
		argumentsJson,
	});
}

function parseProviderReplayState(value: unknown): ProviderReplayState {
	const state = boundedRecord(value, "provider replay state");
	assertObjectShape(state, ["provider", "value"], ["tokenEstimate"], "provider replay state");
	return Object.freeze({
		provider: oneOf(state.provider, PROVIDERS, "provider replay state provider"),
		value: jsonRecord(state.value, "provider replay state value"),
		...(hasOwn(state, "tokenEstimate") ? {
			tokenEstimate: boundedInteger(
				state.tokenEstimate,
				"provider replay state token estimate",
				0,
			),
		} : {}),
	});
}

function parseContextMetadata(value: unknown): CanonicalContextMetadata {
	const metadata = boundedRecord(value, "provider context metadata");
	assertObjectShape(metadata,
		["kind", "cacheClass", "durability", "scope", "sourceId", "contentSha256", "contentLength"],
		["role", "supersedesItemId", "tombstone"],
		"provider context metadata");
	return Object.freeze({
		kind: oneOf(metadata.kind, [
			"collaboration_mode", "permissions", "tool_exposure", "skill_catalog",
			"skill_instructions", "workspace_instructions", "environment_context",
			"conversation_context", "memory", "compaction_rehydration", "plan",
			"hook_context", "runtime_policy_reminder", "runtime_context_reminder",
			"subagent_context", "turn_aborted",
		] as const, "provider context kind"),
		cacheClass: oneOf(metadata.cacheClass,
			["static", "dynamic", "ephemeral"] as const,
			"provider context cache class"),
		durability: oneOf(metadata.durability, ["persistent"] as const, "provider context durability"),
		scope: oneOf(metadata.scope,
			["session", "turn", "transcript"] as const,
			"provider context scope"),
		sourceId: contextIdentity(metadata.sourceId, "provider context source"),
		contentSha256: patternString(
			metadata.contentSha256,
			"provider context content hash",
			SHA256_PATTERN,
		),
		contentLength: boundedInteger(
			metadata.contentLength,
			"provider context content length",
			0,
			CONTEXT_CONTENT_MAX_CHARS,
		),
		...(hasOwn(metadata, "role") ? {
			role: oneOf(metadata.role, ["developer", "user"] as const, "provider context role"),
		} : {}),
		...(hasOwn(metadata, "supersedesItemId") ? {
			supersedesItemId: contextIdentity(
				metadata.supersedesItemId,
				"superseded provider context",
			),
		} : {}),
		...(hasOwn(metadata, "tombstone") ? {
			tombstone: booleanValue(metadata.tombstone, "provider context tombstone"),
		} : {}),
	});
}

function parseRuntimeEvent(value: unknown): RuntimeEvent {
	const event = boundedRecord(value, "provider runtime event");
	switch (event.type) {
		case "reasoning_delta":
		case "text_delta":
			assertExactKeys(event, ["type", "text"], "provider delta event");
			return Object.freeze({
				type: event.type,
				text: boundedString(event.text, "provider event text", AGENT_WORKER_PROVIDER_RPC_MAX_BYTES),
			});
		case "stream_retrying":
			assertExactKeys(event, ["type", "attempt", "delayMs"], "provider retry event");
			return Object.freeze({
				type: event.type,
				attempt: boundedInteger(event.attempt, "provider retry attempt", 1, 100),
				delayMs: boundedInteger(event.delayMs, "provider retry delay", 0, 3_600_000),
			});
		case "stream_recovered":
			assertExactKeys(event, ["type"], "provider recovery event");
			return Object.freeze({ type: event.type });
		case "message_complete":
			assertExactKeys(event, event.responseId === undefined
				? ["type"]
				: ["type", "responseId"], "provider completion event");
			return Object.freeze({
				type: event.type,
				...(event.responseId === undefined
					? {}
					: { responseId: boundedString(event.responseId, "provider response", IDENTITY_MAX_CHARS) }),
			});
		default:
			throw invalid("provider runtime event type is invalid");
	}
}

function parseProviderResult(value: unknown): ProviderAgentLoopResult {
	const result = boundedRecord(value, "provider step result");
	if ("failure" in result) {
		assertExactKeys(result, ["failure", "eventsObserved"], "provider failure result");
		return Object.freeze({
			failure: parseProviderFailure(result.failure),
			eventsObserved: boundedInteger(result.eventsObserved, "provider events observed", 0),
		});
	}
	assertObjectShape(result,
		["assistantText", "usage", "toolCalls"],
		["responseId", "providerState"],
		"provider success result");
	return Object.freeze({
		assistantText: boundedText(result.assistantText, "provider assistant text", TEXT_MAX_CHARS),
		usage: parseUsage(result.usage),
		toolCalls: boundedArray(result.toolCalls, "provider result tool calls", parseCanonicalToolCall),
		...(hasOwn(result, "responseId") ? {
			responseId: boundedString(result.responseId, "provider result response", IDENTITY_MAX_CHARS),
		} : {}),
		...(hasOwn(result, "providerState") ? {
			providerState: parseProviderReplayState(result.providerState),
		} : {}),
	});
}

function parseProviderFailure(value: unknown): ProviderAgentLoopFailure {
	const failure = boundedRecord(value, "provider failure");
	assertObjectShape(failure,
		["code", "message", "retryable"],
		["retryAfterSeconds", "diagnostics"],
		"provider failure");
	return Object.freeze({
		code: oneOf(failure.code, RUNTIME_ERROR_CODES, "provider failure code"),
		message: boundedText(failure.message, "provider failure message", TEXT_MAX_CHARS),
		retryable: booleanValue(failure.retryable, "provider failure retryable flag"),
		...(hasOwn(failure, "retryAfterSeconds") ? {
			retryAfterSeconds: boundedFiniteNumber(
				failure.retryAfterSeconds,
				"provider retry delay",
				0,
				3_600,
			),
		} : {}),
		...(hasOwn(failure, "diagnostics") ? {
			diagnostics: parseDiagnostics(failure.diagnostics),
		} : {}),
	});
}

function parseUsage(value: unknown): ProviderUsage {
	const usage = boundedRecord(value, "provider usage");
	if (Object.keys(usage).length > USAGE_MAX_KEYS) throw invalid("provider usage has too many fields");
	return Object.freeze(Object.fromEntries(Object.entries(usage).map(([key, amount]) => [
		patternString(key, "provider usage key", /^[A-Za-z][A-Za-z0-9_]{0,127}$/u),
		boundedFiniteNumber(amount, `provider usage ${key}`, 0),
	])));
}

function parseDiagnostics(value: unknown): Readonly<Record<string, string | number | boolean | null>> {
	const diagnostics = boundedRecord(value, "provider diagnostics");
	if (Object.keys(diagnostics).length > DIAGNOSTIC_MAX_KEYS) {
		throw invalid("provider diagnostics has too many fields");
	}
	return Object.freeze(Object.fromEntries(Object.entries(diagnostics).map(([key, item]) => {
		const parsedKey = patternString(
			key,
			"provider diagnostic key",
			/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u,
		);
		if (item === null || typeof item === "boolean") return [parsedKey, item];
		if (typeof item === "string") {
			return [parsedKey, boundedText(item, `provider diagnostic ${key}`, DIAGNOSTIC_VALUE_MAX_CHARS)];
		}
		return [parsedKey, boundedFiniteNumber(item, `provider diagnostic ${key}`)];
	})));
}

function boundedRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw invalid(`${label} is not an object`);
	let json: string;
	try {
		json = stableModelInputJson(value);
	} catch {
		throw invalid(`${label} is not serializable`);
	}
	if (Buffer.byteLength(json, "utf8") > AGENT_WORKER_PROVIDER_RPC_MAX_BYTES) {
		throw invalid(`${label} exceeds its byte limit`);
	}
	return value;
}

function assertExactKeys(
	record: Readonly<Record<string, unknown>>,
	keys: readonly string[],
	label: string,
): void {
	const expected = new Set(keys);
	if (Object.keys(record).length !== expected.size
		|| Object.keys(record).some((key) => !expected.has(key))) {
		throw invalid(`${label} has invalid fields`);
	}
}

function assertObjectShape(
	record: Readonly<Record<string, unknown>>,
	required: readonly string[],
	optional: readonly string[],
	label: string,
): void {
	const allowed = new Set([...required, ...optional]);
	if (required.some((key) => !hasOwn(record, key))
		|| Object.keys(record).some((key) => !allowed.has(key))) {
		throw invalid(`${label} has invalid fields`);
	}
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function boundedArray<Value>(
	value: unknown,
	label: string,
	parse: (item: unknown) => Value,
): readonly Value[] {
	if (!Array.isArray(value) || value.length > LIST_MAX_ITEMS) {
		throw invalid(`${label} is invalid`);
	}
	return Object.freeze(value.map(parse));
}

function jsonRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
	if (!isPlainRecord(value)) throw invalid(`${label} is not a JSON object`);
	return parseJsonRecord(value, label, 0);
}

function parseJsonRecord(
	value: Readonly<Record<string, unknown>>,
	label: string,
	depth: number,
): Readonly<Record<string, unknown>> {
	if (depth >= JSON_MAX_DEPTH || Object.keys(value).length > RECORD_MAX_KEYS) {
		throw invalid(`${label} exceeds its structural limit`);
	}
	return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => {
		if (key.length > IDENTITY_MAX_CHARS) throw invalid(`${label} has an invalid key`);
		return [key, parseJsonValue(item, label, depth + 1)];
	})));
}

function parseJsonValue(value: unknown, label: string, depth: number): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) {
		if (depth >= JSON_MAX_DEPTH || value.length > LIST_MAX_ITEMS) {
			throw invalid(`${label} exceeds its structural limit`);
		}
		return Object.freeze(value.map((item) => parseJsonValue(item, label, depth + 1)));
	}
	if (isPlainRecord(value)) return parseJsonRecord(value, label, depth);
	throw invalid(`${label} is not valid JSON`);
}

function parseJsonObjectString(value: string, label: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		throw invalid(`${label} is not valid JSON`);
	}
	jsonRecord(parsed, label);
}

function identity(value: unknown, label: string): string {
	return boundedString(value, label, IDENTITY_MAX_CHARS, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
}

function contextIdentity(value: unknown, label: string): string {
	const parsed = boundedString(value, label, 128);
	if (parsed.includes("/") || parsed.includes("\\") || parsed.includes("\0")) {
		throw invalid(`${label} is invalid`);
	}
	return parsed;
}

function boundedString(
	value: unknown,
	label: string,
	maxChars: number,
	pattern?: RegExp,
): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maxChars
		|| (pattern && !pattern.test(value))) {
		throw invalid(`${label} is invalid`);
	}
	return value;
}

function boundedText(value: unknown, label: string, maxChars: number): string {
	if (typeof value !== "string" || value.length > maxChars) throw invalid(`${label} is invalid`);
	return value;
}

function patternString(value: unknown, label: string, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) throw invalid(`${label} is invalid`);
	return value;
}

function boundedInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw invalid(`${label} is invalid`);
	}
	return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw invalid(`${label} is invalid`);
	return value;
}

function boundedFiniteNumber(
	value: unknown,
	label: string,
	minimum = -Number.MAX_VALUE,
	maximum = Number.MAX_VALUE,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)
		|| value < minimum || value > maximum) {
		throw invalid(`${label} is invalid`);
	}
	return value;
}

function oneOf<const Values extends readonly string[]>(
	value: unknown,
	values: Values,
	label: string,
): Values[number] {
	if (typeof value !== "string" || !values.includes(value)) throw invalid(`${label} is invalid`);
	return value as Values[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): AgentWorkerProviderRpcError {
	return new AgentWorkerProviderRpcError(message);
}

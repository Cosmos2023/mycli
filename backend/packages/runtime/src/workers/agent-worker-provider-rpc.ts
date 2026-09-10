import { isAbsolute } from "node:path";
import {
	canonicalRuntimeFailureMessage,
	parseProviderAttemptUpdate,
	readErrorContext,
	RUNTIME_ERROR_CODES,
	RUNTIME_RETRY_AFTER_MAX_SECONDS,
	runtimeErrorPublicMessage,
	sanitizeRuntimeErrorDetail,
} from "@mycli/contracts";
import type { ProviderAttemptUpdate } from "@mycli/contracts";
import {
	isProviderRouteId,
	normalizeCanonicalImages,
	parseProviderNativeTransportSnapshot,
	providerNativeEndpointSha256,
	providerNativeProtocol,
	stableModelInputJson,
} from "@mycli/core";
import type {
	CanonicalContextMetadata,
	CanonicalConversationItem,
	CanonicalImage,
	CanonicalMessage,
	CanonicalToolCall,
	ProviderRouteId,
	ProviderReplayState,
	ProviderRequest,
	ProviderNativeTransportSnapshot,
	ProviderUsage,
	ProtocolId,
	RuntimeEvent,
	ToolDefinition,
	WebSearchAction,
	WebSearchCall,
} from "@mycli/core";
import type {
	ProviderAgentLoopFailure,
	ProviderAgentLoopResult,
} from "../providers/provider-agent-loop.ts";
import {
	validatePiAiCompatOverride,
	type PiAiCompatOverride,
	type ProviderRouteDescriptor,
} from "@mycli/providers";
import type { ProviderStreamDiagnostics } from "../runtime-observability.ts";
import { AGENT_WORKER_PROTOCOL_VERSION } from "./agent-worker-protocol.ts";

// Native replay state and image data add bytes beyond the token-counted conversation.
export const AGENT_WORKER_PROVIDER_RPC_MAX_BYTES = 32 * 1024 * 1024;

const IDENTITY_MAX_CHARS = 256;
const API_KEY_MAX_CHARS = 16 * 1024;
const AUTH_REF_MAX_CHARS = 512;
const PRIVATE_ENV_MAX_BYTES = 64 * 1024;
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

const PROTOCOLS = [
	"responses", "chat_completions", "anthropic_messages",
] as const;
export interface AgentWorkerProviderTransportConfig {
	readonly provider: ProviderRouteId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly apiBaseUrl: string;
	readonly apiKey?: string;
	readonly supportsImages: boolean;
	readonly maxPromptTokens: number;
	readonly modelContextWindowTokens?: number;
	readonly maxOutputTokens?: number;
	readonly nativeTransport?: ProviderNativeTransportSnapshot;
	readonly homeDir?: string;
	readonly authRef?: string;
	readonly providerEnv?: Readonly<Record<string, string>>;
	readonly allowAmbientAuth?: boolean;
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
		readonly route: ProviderRouteDescriptor;
		readonly request: ProviderRequest;
		readonly requestMaxRetries: number;
		readonly maxRetries: number;
		readonly toolCallsAllowed: boolean;
		readonly recordAttempts?: boolean;
		readonly attemptState?: ProviderAttemptUpdate;
		readonly streamDiagnosticsVersion?: 1;
		readonly errorContextVersion?: 1;
	})
	| (AgentWorkerProviderRpcIdentity & {
		readonly type: "provider_step_attempt_ack";
		readonly attemptSequence: number;
	})
	| (AgentWorkerProviderRpcIdentity & {
		readonly type: "provider_step_cancel";
		readonly userInitiated?: true;
	});

export type AgentWorkerProviderResponse = AgentWorkerProviderRpcIdentity & (
	| { readonly type: "provider_step_event"; readonly event: RuntimeEvent }
	| { readonly type: "provider_step_attempt"; readonly update: ProviderAttemptUpdate }
	| {
		readonly type: "provider_step_diagnostic";
		readonly diagnostic: ProviderStreamDiagnostics;
	}
	| { readonly type: "provider_step_result"; readonly result: ProviderAgentLoopResult }
);

export interface AgentWorkerProviderDiagnosticEnvelope extends AgentWorkerProviderRpcIdentity {
	readonly type: "provider_step_diagnostic";
	readonly diagnostic: unknown;
}

export class AgentWorkerProviderRpcError extends Error {
	readonly code = "agent_worker_provider_rpc_error" as const;

	constructor(message: string) {
		super(`agent_worker_provider_rpc_error: ${message}`);
		this.name = "AgentWorkerProviderRpcError";
	}
}

export class AgentWorkerProviderRpcSizeError extends AgentWorkerProviderRpcError {
	readonly maxBytes = AGENT_WORKER_PROVIDER_RPC_MAX_BYTES;

	constructor(readonly actualBytes: number) {
		super("provider payload exceeds its byte limit");
		this.name = "AgentWorkerProviderRpcSizeError";
	}
}

export function parseAgentWorkerProviderCommand(value: unknown): AgentWorkerProviderCommand {
	const record = boundedRecord(value, "provider command");
	const identity = parseIdentity(record);
	if (record.type === "provider_step_attempt_ack") {
		assertExactKeys(record, [
			"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
			"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
			"timelineVersion", "requestId", "sequence", "attemptSequence",
		], "provider attempt acknowledgement");
		return Object.freeze({
			type: record.type,
			...identity,
			attemptSequence: boundedInteger(record.attemptSequence, "provider attempt sequence", 1, 1000),
		});
	}
	if (record.type === "provider_step_cancel") {
		assertObjectShape(record, [
			"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
			"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
			"timelineVersion", "requestId", "sequence",
		], ["userInitiated"], "provider cancellation");
		if (hasOwn(record, "userInitiated") && record.userInitiated !== true) throw invalid("invalid cancellation evidence");
		return Object.freeze({ type: record.type, ...identity, ...(record.userInitiated === true ? { userInitiated: true as const } : {}) });
	}
	if (record.type !== "provider_step_execute") throw invalid("provider command type is invalid");
	assertObjectShape(record, [
		"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
		"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
		"timelineVersion", "requestId", "sequence", "config", "request",
		"route", "requestMaxRetries", "maxRetries", "toolCallsAllowed",
	], ["recordAttempts", "attemptState", "streamDiagnosticsVersion", "errorContextVersion"], "provider execution");
	if (hasOwn(record, "errorContextVersion") && record.errorContextVersion !== 1) {
		throw invalid("unsupported error context version");
	}
	if (hasOwn(record, "streamDiagnosticsVersion") && record.streamDiagnosticsVersion !== 1) {
		throw invalid("provider stream diagnostics version is unsupported");
	}
	const config = parseTransportConfig(record.config);
	const route = parseProviderRouteDescriptor(record.route);
	const request = parseProviderRequest(record.request);
	const attemptState = hasOwn(record, "attemptState") ? parseAttemptUpdate(record.attemptState) : undefined;
	if (attemptState && (record.recordAttempts !== true
		|| attemptState.policy.requestMaxRetries !== record.requestMaxRetries
		|| attemptState.policy.streamMaxRetries !== record.maxRetries)) {
		throw invalid("provider attempt state does not match execution policy");
	}
	if (request.provider !== config.provider
		|| request.protocol !== config.protocol
		|| request.model !== config.model) {
		throw invalid("provider request does not match transport config");
	}
	if (route.routeId !== config.provider
		|| route.protocol !== config.protocol
		|| (!config.nativeTransport && normalizedBaseUrl(route.apiBaseUrl) !== normalizedBaseUrl(config.apiBaseUrl))) {
		throw invalid("provider route does not match transport config");
	}
	assertNativeTransportIdentity(config, route, request);
	return Object.freeze({
		type: record.type,
		...identity,
		config,
		route,
		request,
		requestMaxRetries: boundedInteger(
			record.requestMaxRetries,
			"provider request retries",
			0,
			100,
		),
		maxRetries: boundedInteger(record.maxRetries, "provider retries", 0, 100),
		toolCallsAllowed: booleanValue(record.toolCallsAllowed, "tool-call flag"),
		...(hasOwn(record, "recordAttempts") ? { recordAttempts: booleanValue(record.recordAttempts, "attempt recording flag") } : {}),
		...(attemptState ? { attemptState } : {}),
		...(hasOwn(record, "streamDiagnosticsVersion") ? { streamDiagnosticsVersion: 1 as const } : {}),
		...(hasOwn(record, "errorContextVersion") ? { errorContextVersion: 1 as const } : {}),
	});
}

export function parseAgentWorkerProviderDiagnosticEnvelope(
	value: unknown,
): AgentWorkerProviderDiagnosticEnvelope | undefined {
	if (!isRecord(value) || value.type !== "provider_step_diagnostic") return undefined;
	const record = boundedRecord(value, "provider response");
	const identity = parseIdentity(record);
	assertExactKeys(record, [
		"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
		"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
		"timelineVersion", "requestId", "sequence", "diagnostic",
	], "provider diagnostic");
	return Object.freeze({ type: "provider_step_diagnostic", ...identity, diagnostic: record.diagnostic });
}

export function projectAgentWorkerProviderDiagnostics(
	diagnostic: ProviderStreamDiagnostics,
	version: 1 | undefined,
): ProviderStreamDiagnostics {
	if (version === 1) return diagnostic;
	// Coordinators already in memory may still enforce the pre-timing field allowlist.
	return Object.freeze({
		attempt: diagnostic.attempt,
		elapsedMs: diagnostic.elapsedMs,
		textDeltaIntervalCount: diagnostic.textDeltaIntervalCount,
		providerEventCount: diagnostic.providerEventCount,
		reasoningEventCount: diagnostic.reasoningEventCount,
		textEventCount: diagnostic.textEventCount,
		providerStateEventCount: diagnostic.providerStateEventCount,
		toolCallEventCount: diagnostic.toolCallEventCount,
		usageEventCount: diagnostic.usageEventCount,
		completedEventCount: diagnostic.completedEventCount,
		reasoningBytes: diagnostic.reasoningBytes,
		textBytes: diagnostic.textBytes,
		success: diagnostic.success,
		...(diagnostic.ttfbMs === undefined ? {} : { ttfbMs: diagnostic.ttfbMs }),
		...(diagnostic.ttftMs === undefined ? {} : { ttftMs: diagnostic.ttftMs }),
		...(diagnostic.tbtMs === undefined ? {} : { tbtMs: diagnostic.tbtMs }),
		...(diagnostic.maxTbtMs === undefined ? {} : { maxTbtMs: diagnostic.maxTbtMs }),
		...(diagnostic.failureKind === undefined ? {} : { failureKind: diagnostic.failureKind }),
		...(diagnostic.failure === undefined ? {} : { failure: diagnostic.failure }),
	});
}

export function parseAgentWorkerProviderResponse(value: unknown): AgentWorkerProviderResponse {
	const record = boundedRecord(value, "provider response");
	const identity = parseIdentity(record);
	if (record.type === "provider_step_attempt") {
		assertExactKeys(record, [
			"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
			"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
			"timelineVersion", "requestId", "sequence", "update",
		], "provider attempt proposal");
		return Object.freeze({ type: record.type, ...identity, update: parseAttemptUpdate(record.update) });
	}
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
	if (record.type === "provider_step_diagnostic") {
		assertExactKeys(record, [
			"type", "protocolVersion", "coordinatorEpoch", "workerId", "workerGeneration",
			"leaseId", "jobId", "sessionId", "turnId", "timelineWindowId",
			"timelineVersion", "requestId", "sequence", "diagnostic",
		], "provider diagnostic");
		return Object.freeze({
			type: record.type,
			...identity,
			diagnostic: parseProviderStreamDiagnostics(record.diagnostic),
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

function parseAttemptUpdate(value: unknown): ProviderAttemptUpdate {
	try {
		return parseProviderAttemptUpdate(value);
	} catch {
		throw invalid("provider attempt update is invalid");
	}
}

function parseProviderStreamDiagnostics(value: unknown): ProviderStreamDiagnostics {
	const diagnostic = boundedRecord(value, "provider stream diagnostic");
	assertObjectShape(diagnostic, [
		"attempt",
		"elapsedMs",
		"textDeltaIntervalCount",
		"providerEventCount",
		"reasoningEventCount",
		"textEventCount",
		"providerStateEventCount",
		"toolCallEventCount",
		"usageEventCount",
		"completedEventCount",
		"reasoningBytes",
		"textBytes",
		"success",
	], ["ttfbMs", "ttftMs", "tbtMs", "maxTbtMs", "failureKind", "failure",
		"lastTextDeltaMs", "responseTerminalMs", "sdkTerminalMs", "completedEventMs",
		"streamSettledMs", "terminalPersistMs", "textTailMs"], "provider stream diagnostic");
	const failure = hasOwn(diagnostic, "failure") ? parseProviderFailure(diagnostic.failure) : undefined;
	if (failure && (diagnostic.success !== false
		|| (hasOwn(diagnostic, "failureKind") && diagnostic.failureKind !== failure.code))) {
		throw invalid("provider diagnostic failure contradicts attempt outcome");
	}
	return Object.freeze({
		attempt: boundedInteger(diagnostic.attempt, "provider diagnostic attempt", 1, 10_201),
		elapsedMs: diagnosticDuration(diagnostic.elapsedMs, "provider diagnostic elapsed time"),
		...(hasOwn(diagnostic, "ttfbMs") ? {
			ttfbMs: diagnosticDuration(diagnostic.ttfbMs, "provider diagnostic TTFB"),
		} : {}),
		...(hasOwn(diagnostic, "ttftMs") ? {
			ttftMs: diagnosticDuration(diagnostic.ttftMs, "provider diagnostic TTFT"),
		} : {}),
		...(hasOwn(diagnostic, "tbtMs") ? {
			tbtMs: diagnosticDuration(diagnostic.tbtMs, "provider diagnostic TBT"),
		} : {}),
		...(hasOwn(diagnostic, "maxTbtMs") ? {
			maxTbtMs: diagnosticDuration(diagnostic.maxTbtMs, "provider diagnostic maximum TBT"),
		} : {}),
		...(hasOwn(diagnostic, "lastTextDeltaMs") ? {
			lastTextDeltaMs: diagnosticDuration(diagnostic.lastTextDeltaMs, "provider diagnostic last text delta"),
		} : {}),
		...(hasOwn(diagnostic, "responseTerminalMs") ? {
			responseTerminalMs: diagnosticDuration(diagnostic.responseTerminalMs, "provider diagnostic response terminal"),
		} : {}),
		...(hasOwn(diagnostic, "sdkTerminalMs") ? {
			sdkTerminalMs: diagnosticDuration(diagnostic.sdkTerminalMs, "provider diagnostic SDK terminal"),
		} : {}),
		...(hasOwn(diagnostic, "completedEventMs") ? {
			completedEventMs: diagnosticDuration(diagnostic.completedEventMs, "provider diagnostic completion event"),
		} : {}),
		...(hasOwn(diagnostic, "streamSettledMs") ? {
			streamSettledMs: diagnosticDuration(diagnostic.streamSettledMs, "provider diagnostic stream settlement"),
		} : {}),
		...(hasOwn(diagnostic, "terminalPersistMs") ? {
			terminalPersistMs: diagnosticDuration(diagnostic.terminalPersistMs, "provider diagnostic terminal persistence"),
		} : {}),
		...(hasOwn(diagnostic, "textTailMs") ? {
			textTailMs: diagnosticDuration(diagnostic.textTailMs, "provider diagnostic text tail"),
		} : {}),
		textDeltaIntervalCount: diagnosticCount(
			diagnostic.textDeltaIntervalCount,
			"provider diagnostic text interval count",
		),
		providerEventCount: diagnosticCount(
			diagnostic.providerEventCount,
			"provider diagnostic event count",
		),
		reasoningEventCount: diagnosticCount(
			diagnostic.reasoningEventCount,
			"provider diagnostic reasoning event count",
		),
		textEventCount: diagnosticCount(
			diagnostic.textEventCount,
			"provider diagnostic text event count",
		),
		providerStateEventCount: diagnosticCount(
			diagnostic.providerStateEventCount,
			"provider diagnostic state event count",
		),
		toolCallEventCount: diagnosticCount(
			diagnostic.toolCallEventCount,
			"provider diagnostic tool-call event count",
		),
		usageEventCount: diagnosticCount(
			diagnostic.usageEventCount,
			"provider diagnostic usage event count",
		),
		completedEventCount: diagnosticCount(
			diagnostic.completedEventCount,
			"provider diagnostic completion event count",
		),
		reasoningBytes: diagnosticCount(
			diagnostic.reasoningBytes,
			"provider diagnostic reasoning bytes",
		),
		textBytes: diagnosticCount(diagnostic.textBytes, "provider diagnostic text bytes"),
		success: booleanValue(diagnostic.success, "provider diagnostic success flag"),
		...(hasOwn(diagnostic, "failureKind") ? {
			failureKind: oneOf(
				diagnostic.failureKind,
				RUNTIME_ERROR_CODES,
				"provider diagnostic failure kind",
			),
		} : {}),
		...(failure ? { failure } : {}),
	});
}

function diagnosticDuration(value: unknown, label: string): number {
	return boundedFiniteNumber(value, label, 0, 24 * 60 * 60 * 1_000);
}

function diagnosticCount(value: unknown, label: string): number {
	return boundedInteger(value, label, 0, 1_099_511_627_776);
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
	const keys = [
		"provider", "protocol", "model", "apiBaseUrl", "supportsImages", "maxPromptTokens",
	];
	if (config.apiKey !== undefined) keys.push("apiKey");
	if (config.modelContextWindowTokens !== undefined) keys.push("modelContextWindowTokens");
	if (config.maxOutputTokens !== undefined) keys.push("maxOutputTokens");
	if (config.nativeTransport !== undefined) keys.push("nativeTransport");
	if (config.homeDir !== undefined) keys.push("homeDir");
	if (config.authRef !== undefined) keys.push("authRef");
	if (config.providerEnv !== undefined) keys.push("providerEnv");
	if (config.allowAmbientAuth !== undefined) keys.push("allowAmbientAuth");
	assertExactKeys(config, keys, "provider transport config");
	const provider = providerRoute(config.provider, "provider");
	const protocol = oneOf(config.protocol, PROTOCOLS, "provider protocol");
	const apiBaseUrl = providerBaseUrl(config.apiBaseUrl, "provider base URL");
	return Object.freeze({
		provider,
		protocol,
		model: boundedString(config.model, "provider model", IDENTITY_MAX_CHARS),
		apiBaseUrl,
		supportsImages: booleanValue(config.supportsImages, "provider image support"),
		maxPromptTokens: boundedInteger(config.maxPromptTokens, "maximum prompt tokens", 1),
		...(config.modelContextWindowTokens === undefined ? {} : {
			modelContextWindowTokens: boundedInteger(
				config.modelContextWindowTokens,
				"model context window tokens",
				1,
			),
		}),
		...(config.maxOutputTokens === undefined ? {} : {
			maxOutputTokens: boundedInteger(config.maxOutputTokens, "maximum output tokens", 1),
		}),
		...(config.apiKey === undefined
			? {}
			: { apiKey: boundedString(config.apiKey, "provider API key", API_KEY_MAX_CHARS) }),
		...(config.nativeTransport === undefined ? {} : { nativeTransport: parseNativeTransport(config.nativeTransport) }),
		...(config.homeDir === undefined ? {} : { homeDir: privateHomeDir(config.homeDir) }),
		...(config.authRef === undefined ? {} : { authRef: privateAuthRef(config.authRef) }),
		...(config.providerEnv === undefined ? {} : { providerEnv: parsePrivateProviderEnv(config.providerEnv) }),
		...(config.allowAmbientAuth === undefined ? {} : {
			allowAmbientAuth: booleanValue(config.allowAmbientAuth, "ambient provider authentication flag"),
		}),
	});
}

function parseNativeTransport(value: unknown): ProviderNativeTransportSnapshot {
	try {
		return parseProviderNativeTransportSnapshot(value);
	} catch {
		throw invalid("provider native transport snapshot is invalid");
	}
}

function assertNativeTransportIdentity(
	config: AgentWorkerProviderTransportConfig,
	route: ProviderRouteDescriptor,
	request: ProviderRequest,
): void {
	const snapshot = config.nativeTransport;
	if (!snapshot && !route.nativeTransport && !request.nativeTransport) return;
	if (!snapshot || !route.nativeTransport || !request.nativeTransport
		|| route.source !== "pi_ai_builtin"
		|| snapshot.catalogProviderId !== route.catalogProviderId
		|| snapshot.modelId !== config.model
		|| providerNativeProtocol(snapshot.api) !== config.protocol
		|| stableModelInputJson(snapshot) !== stableModelInputJson(route.nativeTransport)
		|| stableModelInputJson(snapshot) !== stableModelInputJson(request.nativeTransport)) {
		throw invalid("provider native transport identity does not match committed request");
	}
	try {
		if (snapshot.endpointSha256 !== providerNativeEndpointSha256(config.apiBaseUrl)
			|| snapshot.endpointSha256 !== providerNativeEndpointSha256(route.apiBaseUrl)) {
			throw invalid("provider native endpoint does not match committed request");
		}
	} catch {
		throw invalid("provider native endpoint does not match committed request");
	}
}

function privateHomeDir(value: unknown): string {
	const directory = boundedString(value, "private provider home directory", 4096);
	if (!isAbsolute(directory) || directory.includes("\0") || /[\r\n]/u.test(directory)) throw invalid("private provider home directory is invalid");
	return directory;
}

function privateAuthRef(value: unknown): string {
	const reference = boundedString(value, "provider auth reference", AUTH_REF_MAX_CHARS);
	if (reference.includes("\0") || /[\r\n]/u.test(reference)) throw invalid("provider auth reference is invalid");
	return reference;
}

function parsePrivateProviderEnv(value: unknown): Readonly<Record<string, string>> {
	const record = boundedRecord(value, "private provider environment");
	const entries = Object.entries(record);
	if (entries.length > 128 || Buffer.byteLength(stableModelInputJson(record)) > PRIVATE_ENV_MAX_BYTES) {
		throw invalid("private provider environment exceeds its limit");
	}
	return Object.freeze(Object.fromEntries(entries.map(([name, raw]) => {
		const key = boundedString(name, "private provider environment name", 128, /^[A-Z_][A-Z0-9_]*$/u);
		const content = boundedText(raw, "private provider environment value", API_KEY_MAX_CHARS);
		if (content.includes("\0")) throw invalid("private provider environment value is invalid");
		return [key, content];
	})));
}

function parseProviderRouteDescriptor(value: unknown): ProviderRouteDescriptor {
	const route = boundedRecord(value, "provider route descriptor");
	const keys = [
		"routeId", "displayName", "supportTier", "source", "protocol", "apiBaseUrl",
		"authRef", "activation", "modelPolicy", "snapshotVersion",
	];
	if (route.catalogProviderId !== undefined) keys.push("catalogProviderId");
	if (route.compat !== undefined) keys.push("compat");
	if (route.modelCompat !== undefined) keys.push("modelCompat");
	if (route.nativeTransport !== undefined) keys.push("nativeTransport");
	assertExactKeys(route, keys, "provider route descriptor");
	const source = oneOf(
		route.source,
		["pi_ai_builtin", "pi_ai_declared"] as const,
		"provider route source",
	);
	const catalogProviderId = route.catalogProviderId === undefined
		? undefined
		: providerRoute(route.catalogProviderId, "catalog provider");
	if ((source === "pi_ai_builtin") !== (catalogProviderId !== undefined)) {
		throw invalid("provider route catalog identity is invalid");
	}
	const activation = oneOf(
		route.activation,
		["active", "inactive", "unserviceable"] as const,
		"provider route activation",
	);
	if (activation !== "active") throw invalid("provider route is not active");
	const protocol = oneOf(route.protocol, PROTOCOLS, "provider route protocol");
	const compat = parseCompatOverride(route.compat, protocol, "provider route compat");
	const modelCompat = parseModelCompat(route.modelCompat, protocol);
	return Object.freeze({
		routeId: providerRoute(route.routeId, "provider route"),
		displayName: boundedString(route.displayName, "provider display name", 512),
		supportTier: oneOf(
			route.supportTier,
			["stable", "experimental", "compatible"] as const,
			"provider support tier",
		),
		source,
		...(catalogProviderId === undefined ? {} : { catalogProviderId }),
		protocol,
		apiBaseUrl: providerBaseUrl(route.apiBaseUrl, "provider route base URL"),
		authRef: privateAuthRef(route.authRef),
		activation,
		modelPolicy: parseProviderRouteModelPolicy(route.modelPolicy),
		...(compat === undefined ? {} : { compat }),
		...(modelCompat === undefined ? {} : { modelCompat }),
		...(route.nativeTransport === undefined ? {} : { nativeTransport: parseNativeTransport(route.nativeTransport) }),
		snapshotVersion: boundedInteger(route.snapshotVersion, "provider snapshot version", 1),
	});
}

function parseModelCompat(
	value: unknown,
	protocol: ProtocolId,
): Readonly<Record<string, PiAiCompatOverride>> | undefined {
	if (value === undefined) return undefined;
	const record = boundedRecord(value, "provider model compat");
	if (Object.keys(record).length === 0) throw invalid("provider model compat is invalid");
	return Object.freeze(Object.fromEntries(Object.entries(record).map(([model, compat]) => [
		boundedString(model, "provider model compat id", 512),
		parseCompatOverride(compat, protocol, "provider model compat")!,
	])));
}

function parseCompatOverride(
	value: unknown,
	protocol: ProtocolId,
	label: string,
): PiAiCompatOverride | undefined {
	if (value === undefined) return undefined;
	try {
		return validatePiAiCompatOverride(protocol, jsonRecord(value, label));
	} catch {
		throw invalid(`${label} is invalid`);
	}
}

function parseProviderRouteModelPolicy(
	value: unknown,
): ProviderRouteDescriptor["modelPolicy"] {
	const policy = boundedRecord(value, "provider route model policy");
	if (policy.kind === "catalog") {
		assertExactKeys(policy, ["kind"], "provider catalog model policy");
		return Object.freeze({ kind: "catalog" });
	}
	const kind = oneOf(
		policy.kind,
		["subset", "declared"] as const,
		"provider route model policy",
	);
	assertExactKeys(policy, ["kind", "modelIds"], "provider route model policy");
	const modelIds = boundedArray(
		policy.modelIds,
		"provider route model ids",
		(item) => boundedString(item, "provider route model id", 512),
	);
	if (modelIds.length === 0 || new Set(modelIds).size !== modelIds.length) {
		throw invalid("provider route model ids are invalid");
	}
	return Object.freeze({ kind, modelIds: Object.freeze(modelIds) });
}

function providerBaseUrl(value: unknown, label: string): string {
	const baseUrl = boundedString(value, label, URL_MAX_CHARS);
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw invalid(`${label} is invalid`);
	}
	if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
		|| parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw invalid(`${label} is invalid`);
	}
	return baseUrl;
}

function normalizedBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/u, "");
}

function parseProviderRequest(value: unknown): ProviderRequest {
	const request = boundedRecord(value, "provider request");
	assertObjectShape(request,
		["provider", "protocol", "model", "instructions", "messages", "tools"],
		[
			"reasoningEffort", "maxOutputTokens", "sessionId", "cacheRetention",
			"webSearchMode", "developerInstructions", "items", "previousResponseId",
			"nativeTransport",
		],
		"provider request");
	return Object.freeze({
		provider: providerRoute(request.provider, "request provider"),
		protocol: oneOf(request.protocol, PROTOCOLS, "request protocol"),
		model: boundedString(request.model, "provider model", IDENTITY_MAX_CHARS),
		instructions: boundedText(request.instructions, "provider instructions", TEXT_MAX_CHARS),
		messages: boundedArray(request.messages, "provider messages", parseCanonicalMessage),
		tools: boundedArray(request.tools, "provider tools", parseToolDefinition),
		...(hasOwn(request, "nativeTransport") ? { nativeTransport: parseNativeTransport(request.nativeTransport) } : {}),
		...(hasOwn(request, "reasoningEffort") ? {
				reasoningEffort: oneOf(request.reasoningEffort,
					["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const,
				"reasoning effort"),
		} : {}),
		...(hasOwn(request, "maxOutputTokens") ? {
			maxOutputTokens: boundedInteger(request.maxOutputTokens, "maximum output tokens", 1),
		} : {}),
		...(hasOwn(request, "sessionId") ? {
			sessionId: boundedString(request.sessionId, "provider cache session", IDENTITY_MAX_CHARS),
		} : {}),
		...(hasOwn(request, "cacheRetention") ? {
			cacheRetention: oneOf(
				request.cacheRetention,
				["none", "short", "long"] as const,
				"provider cache retention",
			),
		} : {}),
		...(hasOwn(request, "webSearchMode") ? {
			webSearchMode: oneOf(
				request.webSearchMode,
				["live", "disabled"] as const,
				"web-search mode",
			),
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
					images: normalizeCanonicalImages(boundedArray(item.images, "provider images", parseCanonicalImage)),
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
			assertObjectShape(item,
				["type", "callId", "toolName", "output", "success"],
				["images"],
				"provider tool result item");
			return Object.freeze({
				type: item.type,
				callId: boundedString(item.callId, "provider tool result call", IDENTITY_MAX_CHARS),
				toolName: boundedString(item.toolName, "provider tool result name", IDENTITY_MAX_CHARS),
				output: boundedText(item.output, "provider tool result output", TEXT_MAX_CHARS),
				success: booleanValue(item.success, "provider tool result success"),
				...(hasOwn(item, "images") ? {
					images: normalizeCanonicalImages(boundedArray(item.images, "provider images", parseCanonicalImage)),
				} : {}),
			});
		default:
			throw invalid("provider conversation item type is invalid");
	}
}

function parseCanonicalImage(value: unknown): CanonicalImage {
	const image = boundedRecord(value, "provider image");
	assertObjectShape(image, ["mediaType", "data"], ["detail"], "provider image");
	const data = boundedString(image.data, "provider image data", TEXT_MAX_CHARS);
	if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
		throw invalid("provider image data is invalid");
	}
	return Object.freeze({
		mediaType: oneOf(image.mediaType,
			["image/jpeg", "image/png", "image/gif", "image/webp"] as const,
			"provider image media type"),
		data,
		...(image.detail === undefined ? {} : {
			detail: oneOf(image.detail, ["high", "original"] as const, "provider image detail"),
		}),
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
		provider: providerRoute(state.provider, "provider replay state provider"),
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
		case "stream_retrying": {
			assertExactKeys(event, [
				"type",
				"attempt",
				"maxRetries",
				"delayMs",
				"recoveryKind",
				"resetOutput",
				"failureKind",
				"additionalDetails",
			], "provider retry event");
			const failureKind = oneOf(
				event.failureKind,
				RUNTIME_ERROR_CODES,
				"provider retry failure kind",
			);
			const additionalDetails = sanitizeRuntimeErrorDetail(boundedText(
				event.additionalDetails,
				"provider retry details",
				DIAGNOSTIC_VALUE_MAX_CHARS,
			)) ?? runtimeErrorPublicMessage(failureKind);
			return Object.freeze({
				type: event.type,
				attempt: boundedInteger(event.attempt, "provider retry attempt", 1, 100),
				maxRetries: boundedInteger(event.maxRetries, "provider retry limit", 0, 100),
				delayMs: boundedInteger(
					event.delayMs,
					"provider retry delay",
					0,
					RUNTIME_RETRY_AFTER_MAX_SECONDS * 1_000,
				),
				recoveryKind: oneOf(
					event.recoveryKind,
					["request", "stream"] as const,
					"provider recovery kind",
				),
				resetOutput: booleanValue(event.resetOutput, "provider retry output reset flag"),
				failureKind,
				additionalDetails,
			});
		}
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
		case "web_search_started":
			assertExactKeys(event, ["type", "callId"], "web-search start event");
			return Object.freeze({
				type: event.type,
				callId: boundedString(event.callId, "web-search call", IDENTITY_MAX_CHARS),
			});
		case "web_search_completed":
			assertExactKeys(event, ["type", "call"], "web-search completion event");
			return Object.freeze({
				type: event.type,
				call: parseWebSearchCall(event.call),
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
		["assistantText", "usage", "toolCalls", "webSearchCalls"],
		["responseId", "providerState"],
		"provider success result");
	return Object.freeze({
		assistantText: boundedText(result.assistantText, "provider assistant text", TEXT_MAX_CHARS),
		usage: parseUsage(result.usage),
		toolCalls: boundedArray(result.toolCalls, "provider result tool calls", parseCanonicalToolCall),
		webSearchCalls: boundedArray(
			result.webSearchCalls,
			"provider result web-search calls",
			parseWebSearchCall,
		),
		...(hasOwn(result, "responseId") ? {
			responseId: boundedString(result.responseId, "provider result response", IDENTITY_MAX_CHARS),
		} : {}),
		...(hasOwn(result, "providerState") ? {
			providerState: parseProviderReplayState(result.providerState),
		} : {}),
	});
}

function parseWebSearchCall(value: unknown): WebSearchCall {
	const call = boundedRecord(value, "web-search call");
	assertExactKeys(call, ["callId", "action"], "web-search call");
	return Object.freeze({
		callId: boundedString(call.callId, "web-search call id", IDENTITY_MAX_CHARS),
		action: parseWebSearchAction(call.action),
	});
}

function parseWebSearchAction(value: unknown): WebSearchAction {
	const action = boundedRecord(value, "web-search action");
	switch (action.type) {
		case "search":
			assertObjectShape(action, ["type"], ["query", "queries"], "web-search action");
			return Object.freeze({
				type: action.type,
				...(hasOwn(action, "query") ? {
					query: boundedText(action.query, "web-search query", DIAGNOSTIC_VALUE_MAX_CHARS),
				} : {}),
				...(hasOwn(action, "queries") ? {
					queries: boundedArray(
						action.queries,
						"web-search queries",
						(item) => boundedText(item, "web-search query", DIAGNOSTIC_VALUE_MAX_CHARS),
					),
				} : {}),
			});
		case "open_page":
			assertObjectShape(action, ["type"], ["url"], "web-search action");
			return Object.freeze({
				type: action.type,
				...(hasOwn(action, "url") ? {
					url: boundedText(action.url, "web-search URL", URL_MAX_CHARS),
				} : {}),
			});
		case "find_in_page":
			assertObjectShape(action, ["type"], ["url", "pattern"], "web-search action");
			return Object.freeze({
				type: action.type,
				...(hasOwn(action, "url") ? {
					url: boundedText(action.url, "web-search URL", URL_MAX_CHARS),
				} : {}),
				...(hasOwn(action, "pattern") ? {
					pattern: boundedText(
						action.pattern,
						"web-search pattern",
						DIAGNOSTIC_VALUE_MAX_CHARS,
					),
				} : {}),
			});
		case "other":
			assertExactKeys(action, ["type"], "web-search action");
			return Object.freeze({ type: action.type });
		default:
			throw invalid("web-search action type is invalid");
	}
}

function parseProviderFailure(value: unknown): ProviderAgentLoopFailure {
	const failure = boundedRecord(value, "provider failure");
	assertObjectShape(failure,
		["code", "message", "retryable"],
		["additionalDetails", "retryAfterSeconds", "diagnostics", "errorContext"],
		"provider failure");
	const additionalDetails = hasOwn(failure, "additionalDetails")
		? sanitizeRuntimeErrorDetail(boundedText(
			failure.additionalDetails,
			"provider failure additional details",
			DIAGNOSTIC_VALUE_MAX_CHARS,
		))
		: undefined;
	const code = oneOf(failure.code, RUNTIME_ERROR_CODES, "provider failure code");
	const errorContext = readErrorContext(failure.errorContext);
	return Object.freeze({
		code,
		message: canonicalRuntimeFailureMessage(
			code,
			boundedText(failure.message, "provider failure message", DIAGNOSTIC_VALUE_MAX_CHARS),
			errorContext,
		),
		...(errorContext ? { errorContext } : {}),
		...(additionalDetails ? { additionalDetails } : {}),
		retryable: booleanValue(failure.retryable, "provider failure retryable flag"),
		...(hasOwn(failure, "retryAfterSeconds") ? {
			retryAfterSeconds: boundedFiniteNumber(
				failure.retryAfterSeconds,
				"provider retry delay",
				0,
				RUNTIME_RETRY_AFTER_MAX_SECONDS,
			),
		} : {}),
		...(hasOwn(failure, "diagnostics") ? {
			diagnostics: parseDiagnostics(failure.diagnostics),
		} : {}),
		...(failure.errorContext !== undefined && !errorContext ? {
			diagnostics: { ...(hasOwn(failure, "diagnostics") ? parseDiagnostics(failure.diagnostics) : {}), error_context_invalid: true },
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
			const text = boundedText(item, `provider diagnostic ${key}`, DIAGNOSTIC_VALUE_MAX_CHARS);
			return [parsedKey, sanitizeRuntimeErrorDetail(text) ?? null];
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
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > AGENT_WORKER_PROVIDER_RPC_MAX_BYTES) {
		throw new AgentWorkerProviderRpcSizeError(bytes);
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

function providerRoute(value: unknown, label: string): ProviderRouteId {
	if (!isProviderRouteId(value)) throw invalid(`${label} is invalid`);
	return value;
}

function invalid(message: string): AgentWorkerProviderRpcError {
	return new AgentWorkerProviderRpcError(message);
}

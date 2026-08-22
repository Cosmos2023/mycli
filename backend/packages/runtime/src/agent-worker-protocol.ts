import { modelInputSha256, stableModelInputJson } from "@mycli/core";

export const AGENT_WORKER_PROTOCOL_VERSION = 1;
export const AGENT_WORKER_MESSAGE_MAX_BYTES = 1024 * 1024;
export const AGENT_WORKER_PAYLOAD_MAX_BYTES = 512 * 1024;

const IDENTITY_MAX_CHARS = 256;
const TEXT_MAX_CHARS = 64 * 1024;
const ARGUMENTS_MAX_CHARS = 256 * 1024;
const LIST_MAX_ITEMS = 256;
const USAGE_MAX_KEYS = 64;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type AgentWorkerMessageKind =
	| "bootstrap_ready"
	| "delta_applied"
	| "provider_step"
	| "provider_lifecycle"
	| "tool_attempt"
	| "approval_request"
	| "clarification_request"
	| "steering_applied"
	| "cancellation_acknowledged"
	| "progress"
	| "usage"
	| "terminal";

export type AgentWorkerMessagePayload =
	| {
		readonly kind: "bootstrap_ready";
		readonly logicalInputSha256: string;
	}
	| {
		readonly kind: "delta_applied";
		readonly baseVersion: number;
		readonly nextVersion: number;
		readonly logicalInputSha256: string;
	}
	| {
		readonly kind: "provider_step";
		readonly providerStep: number;
		readonly logicalInputSha256: string;
	}
	| {
		readonly kind: "provider_lifecycle";
		readonly requestId: string;
		readonly state: "dispatch_started" | "acknowledged" | "failed" | "unknown";
	}
	| {
		readonly kind: "tool_attempt";
		readonly attemptId: string;
		readonly callId: string;
		readonly toolName: string;
		readonly argumentsJson: string;
		readonly mutating: boolean;
	}
	| {
		readonly kind: "approval_request";
		readonly requestId: string;
		readonly callId: string;
		readonly preview: string;
		readonly reason: string;
	}
	| {
		readonly kind: "clarification_request";
		readonly requestId: string;
		readonly callId: string;
		readonly question: string;
		readonly options: readonly string[];
	}
	| {
		readonly kind: "steering_applied";
		readonly queueIds: readonly string[];
	}
	| {
		readonly kind: "cancellation_acknowledged";
		readonly reason: string;
	}
	| {
		readonly kind: "progress";
		readonly summary: string;
	}
	| {
		readonly kind: "usage";
		readonly usage: Readonly<Record<string, number>>;
	}
	| {
		readonly kind: "terminal";
		readonly status: "completed" | "failed" | "interrupted";
		readonly summary: string;
		readonly usage: Readonly<Record<string, number>>;
	};

export interface AgentWorkerMessage {
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
	readonly sequence: number;
	readonly messageKind: AgentWorkerMessageKind;
	readonly payloadSha256: string;
	readonly payload: AgentWorkerMessagePayload;
}

export class AgentWorkerProtocolError extends Error {
	readonly code = "agent_worker_protocol_error" as const;

	constructor(message: string) {
		super(`agent_worker_protocol_error: ${message}`);
		this.name = "AgentWorkerProtocolError";
	}
}

export function agentWorkerPayloadSha256(payload: AgentWorkerMessagePayload): string {
	return modelInputSha256(payload);
}

export function parseAgentWorkerMessage(value: unknown): AgentWorkerMessage {
	const record = boundedRecord(value, "message", AGENT_WORKER_MESSAGE_MAX_BYTES);
	assertExactKeys(record, [
		"protocolVersion",
		"coordinatorEpoch",
		"workerId",
		"workerGeneration",
		"leaseId",
		"jobId",
		"sessionId",
		"turnId",
		"timelineWindowId",
		"timelineVersion",
		"sequence",
		"messageKind",
		"payloadSha256",
		"payload",
	], "message");
	if (record.protocolVersion !== AGENT_WORKER_PROTOCOL_VERSION) {
		throw invalid("unsupported protocol version");
	}
	const messageKind = messageKindValue(record.messageKind);
	const payload = parsePayload(messageKind, record.payload);
	const payloadSha256 = sha256(record.payloadSha256, "payload hash");
	if (payloadSha256 !== agentWorkerPayloadSha256(payload)) {
		throw invalid("payload hash does not match");
	}
	return Object.freeze({
		protocolVersion: AGENT_WORKER_PROTOCOL_VERSION,
		coordinatorEpoch: identity(record.coordinatorEpoch, "coordinator epoch"),
		workerId: identity(record.workerId, "worker"),
		workerGeneration: positiveInteger(record.workerGeneration, "worker generation"),
		leaseId: identity(record.leaseId, "lease"),
		jobId: identity(record.jobId, "job"),
		sessionId: identity(record.sessionId, "session"),
		turnId: identity(record.turnId, "turn"),
		timelineWindowId: identity(record.timelineWindowId, "timeline window"),
		timelineVersion: nonNegativeInteger(record.timelineVersion, "timeline version"),
		sequence: positiveInteger(record.sequence, "message sequence"),
		messageKind,
		payloadSha256,
		payload,
	});
}

function parsePayload(
	kind: AgentWorkerMessageKind,
	value: unknown,
): AgentWorkerMessagePayload {
	const payload = boundedRecord(value, `${kind} payload`, AGENT_WORKER_PAYLOAD_MAX_BYTES);
	if (payload.kind !== kind) throw invalid("message kind does not match payload kind");
	switch (kind) {
		case "bootstrap_ready":
			assertExactKeys(payload, ["kind", "logicalInputSha256"], kind);
			return Object.freeze({ kind, logicalInputSha256: sha256(payload.logicalInputSha256, kind) });
		case "delta_applied": {
			assertExactKeys(payload, ["kind", "baseVersion", "nextVersion", "logicalInputSha256"], kind);
			const baseVersion = nonNegativeInteger(payload.baseVersion, "delta base version");
			const nextVersion = positiveInteger(payload.nextVersion, "delta next version");
			if (nextVersion !== baseVersion + 1) throw invalid("delta versions are not contiguous");
			return Object.freeze({
				kind,
				baseVersion,
				nextVersion,
				logicalInputSha256: sha256(payload.logicalInputSha256, kind),
			});
		}
		case "provider_step":
			assertExactKeys(payload, ["kind", "providerStep", "logicalInputSha256"], kind);
			return Object.freeze({
				kind,
				providerStep: positiveInteger(payload.providerStep, "provider step"),
				logicalInputSha256: sha256(payload.logicalInputSha256, kind),
			});
		case "provider_lifecycle":
			assertExactKeys(payload, ["kind", "requestId", "state"], kind);
			return Object.freeze({
				kind,
				requestId: identity(payload.requestId, "provider request"),
				state: oneOf(payload.state, [
					"dispatch_started", "acknowledged", "failed", "unknown",
				] as const, "provider lifecycle state"),
			});
		case "tool_attempt":
			assertExactKeys(payload, [
				"kind", "attemptId", "callId", "toolName", "argumentsJson", "mutating",
			], kind);
			return Object.freeze({
				kind,
				attemptId: identity(payload.attemptId, "tool attempt"),
				callId: identity(payload.callId, "tool call"),
				toolName: boundedString(payload.toolName, "tool name", IDENTITY_MAX_CHARS),
				argumentsJson: boundedJsonString(payload.argumentsJson, "tool arguments"),
				mutating: booleanValue(payload.mutating, "tool mutation flag"),
			});
		case "approval_request":
			assertExactKeys(payload, ["kind", "requestId", "callId", "preview", "reason"], kind);
			return Object.freeze({
				kind,
				requestId: identity(payload.requestId, "approval request"),
				callId: identity(payload.callId, "approval call"),
				preview: boundedString(payload.preview, "approval preview", TEXT_MAX_CHARS, true),
				reason: boundedString(payload.reason, "approval reason", TEXT_MAX_CHARS, true),
			});
		case "clarification_request":
			assertExactKeys(payload, ["kind", "requestId", "callId", "question", "options"], kind);
			return Object.freeze({
				kind,
				requestId: identity(payload.requestId, "clarification request"),
				callId: identity(payload.callId, "clarification call"),
				question: boundedString(payload.question, "clarification question", TEXT_MAX_CHARS),
				options: boundedStringList(payload.options, "clarification options"),
			});
		case "steering_applied":
			assertExactKeys(payload, ["kind", "queueIds"], kind);
			return Object.freeze({ kind, queueIds: boundedIdentityList(payload.queueIds, "steering queue") });
		case "cancellation_acknowledged":
			assertExactKeys(payload, ["kind", "reason"], kind);
			return Object.freeze({
				kind,
				reason: boundedString(payload.reason, "cancellation reason", TEXT_MAX_CHARS, true),
			});
		case "progress":
			assertExactKeys(payload, ["kind", "summary"], kind);
			return Object.freeze({ kind, summary: boundedString(payload.summary, "progress summary", TEXT_MAX_CHARS) });
		case "usage":
			assertExactKeys(payload, ["kind", "usage"], kind);
			return Object.freeze({ kind, usage: usageValue(payload.usage) });
		case "terminal":
			assertExactKeys(payload, ["kind", "status", "summary", "usage"], kind);
			return Object.freeze({
				kind,
				status: oneOf(payload.status, ["completed", "failed", "interrupted"] as const, "terminal status"),
				summary: boundedString(payload.summary, "terminal summary", TEXT_MAX_CHARS, true),
				usage: usageValue(payload.usage),
			});
	}
}

function boundedRecord(value: unknown, label: string, maximumBytes: number): Record<string, unknown> {
	if (!isRecord(value)) throw invalid(`${label} is not an object`);
	let serialized: string;
	try {
		serialized = stableModelInputJson(value);
	} catch {
		throw invalid(`${label} is not serializable`);
	}
	if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
		throw invalid(`${label} exceeds its byte limit`);
	}
	return value;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
	const allowed = new Set(keys);
	if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !allowed.has(key))) {
		throw invalid(`${label} has invalid fields`);
	}
}

function messageKindValue(value: unknown): AgentWorkerMessageKind {
	return oneOf(value, [
		"bootstrap_ready",
		"delta_applied",
		"provider_step",
		"provider_lifecycle",
		"tool_attempt",
		"approval_request",
		"clarification_request",
		"steering_applied",
		"cancellation_acknowledged",
		"progress",
		"usage",
		"terminal",
	] as const, "message kind");
}

function boundedJsonString(value: unknown, label: string): string {
	const text = boundedString(value, label, ARGUMENTS_MAX_CHARS, true);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw invalid(`${label} is not valid JSON`);
	}
	if (!isRecord(parsed)) throw invalid(`${label} is not a JSON object`);
	return text;
}

function boundedStringList(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.length > LIST_MAX_ITEMS) throw invalid(`${label} is invalid`);
	return Object.freeze(value.map((item) => boundedString(item, label, TEXT_MAX_CHARS)));
}

function boundedIdentityList(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.length > LIST_MAX_ITEMS) throw invalid(`${label} is invalid`);
	const items = value.map((item) => identity(item, label));
	if (new Set(items).size !== items.length) throw invalid(`${label} contains duplicates`);
	return Object.freeze(items);
}

function usageValue(value: unknown): Readonly<Record<string, number>> {
	if (!isRecord(value) || Object.keys(value).length > USAGE_MAX_KEYS) throw invalid("usage is invalid");
	const usage: Record<string, number> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!IDENTITY_PATTERN.test(key) || !Number.isSafeInteger(item) || (item as number) < 0) {
			throw invalid("usage is invalid");
		}
		usage[key] = item as number;
	}
	return Object.freeze(usage);
}

function identity(value: unknown, label: string): string {
	const text = boundedString(value, label, IDENTITY_MAX_CHARS);
	if (!IDENTITY_PATTERN.test(text)) throw invalid(`${label} is invalid`);
	return text;
}

function sha256(value: unknown, label: string): string {
	const text = boundedString(value, label, 64);
	if (!SHA256_PATTERN.test(text)) throw invalid(`${label} is invalid`);
	return text;
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value)) {
		throw invalid(`${label} is invalid`);
	}
	return value;
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid(`${label} is invalid`);
	return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${label} is invalid`);
	return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw invalid(`${label} is invalid`);
	return value;
}

function oneOf<const Value extends string>(
	value: unknown,
	allowed: readonly Value[],
	label: string,
): Value {
	if (typeof value !== "string" || !allowed.includes(value as Value)) throw invalid(`${label} is invalid`);
	return value as Value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): AgentWorkerProtocolError {
	return new AgentWorkerProtocolError(message);
}

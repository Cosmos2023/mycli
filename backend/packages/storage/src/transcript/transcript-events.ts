import { isTurnInterruptionReason, type TurnInterruptionReason } from "@mycli/contracts";
import { parseSessionGoal, parseSkillReferences, type SkillReference } from "@mycli/contracts";
import { createHash } from "node:crypto";
import { isRuntimeErrorCode, readErrorContext, sanitizeRuntimeErrorDetail } from "@mycli/contracts";
import type { ErrorContext, RuntimeErrorCode } from "@mycli/contracts";
import type {
	CanonicalContextMetadata,
	CanonicalConversationItem,
	CanonicalImage,
	CanonicalToolCall,
	CanonicalToolResult,
	ProviderReplayState,
	ProviderUsage,
} from "@mycli/core";
import { isProviderRouteId, parseToolDiscoveries } from "@mycli/core";
import { canonicalImages } from "../artifacts/canonical-images.ts";
import { stableJson } from "../stable-json.ts";

export const TRANSCRIPT_EVENT_SCHEMA_VERSION = 1 as const;
export const TRANSCRIPT_EVENT_MAX_BATCH_ITEMS = 4_096;

const IDENTITY_MAX_CHARS = 512;
const CREATED_AT_MAX_CHARS = 100;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CONTEXT_KINDS = new Set<CanonicalContextMetadata["kind"]>([
	"collaboration_mode",
	"permissions",
	"tool_exposure",
	"skill_catalog",
	"skill_instructions",
	"workspace_instructions",
	"environment_context",
	"conversation_context",
	"memory",
	"compaction_rehydration",
	"plan",
	"hook_context",
	"runtime_policy_reminder",
	"runtime_context_reminder",
	"subagent_context",
	"turn_aborted",
]);

export type TranscriptEventType =
	| "user_input"
	| "assistant_output"
	| "assistant_tool_call_batch"
	| "tool_result"
	| "context"
	| "display_activity"
	| "turn_lifecycle"
	| "rollback"
	| "compaction"
	| "opaque_legacy";

export type TranscriptDisplayActivityType =
	| "reasoning"
	| "plan"
	| "turn_completed"
	| "approval_request"
	| "approval_resolution"
	| "clarification_request"
	| "clarification_response"
	| "shell"
	| "error"
	| "warning"
	| "status"
	| "file_change"
	| "tool_activation"
	| "context_baseline"
	| "capability"
	| "command_result"
	| "web_search"
	| "goal";

export type TranscriptLifecyclePhase = "started" | "completed" | "failed" | "interrupted";

export type TranscriptLegacySourceKind =
	| "conversation_messages"
	| "history_items"
	| "turn_rollouts"
	| "session_summaries";

export type TranscriptLegacyErrorCode =
	| "invalid_json"
	| "invalid_shape"
	| "projection_failure"
	| "source_conflict"
	| "unsupported_shape";

export type TranscriptJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly TranscriptJsonValue[]
	| Readonly<{ [key: string]: TranscriptJsonValue }>;

export interface TranscriptReadableProjection {
	readonly hidden?: boolean;
	readonly searchVisible?: boolean;
	readonly itemId?: string;
	readonly createdAt?: string | null;
	readonly assistantPreambleVisible?: boolean;
	readonly toolCallItemIds?: Readonly<Record<string, string>>;
}

export interface UserInputTranscriptPayload {
	readonly skillReferences?: readonly SkillReference[];
	readonly text: string;
	readonly clientUserMessageId: string;
	readonly queueId?: string;
	readonly source:
		| "submit"
		| "steer"
		| "queued"
		| "agent_mailbox"
		| "task_notification"
		| "approval_resume"
		| "goal";
	readonly images?: readonly CanonicalImage[];
	readonly readableProjection?: TranscriptReadableProjection;
}

export interface AssistantOutputTranscriptPayload {
	readonly text: string;
	readonly responseId?: string;
	readonly providerState?: ProviderReplayState;
	readonly readableProjection?: TranscriptReadableProjection;
}

export interface AssistantToolCallBatchTranscriptPayload {
	readonly text: string;
	readonly calls: readonly CanonicalToolCall[];
	readonly responseId?: string;
	readonly providerState?: ProviderReplayState;
	readonly readableProjection?: TranscriptReadableProjection;
}

export interface ToolResultTranscriptPayload {
	readonly result: CanonicalToolResult;
	readonly summary: string;
	readonly errorKind?: string;
	readonly metadata?: Readonly<Record<string, TranscriptJsonValue>>;
	readonly readableProjection?: TranscriptReadableProjection;
}

export interface ContextTranscriptPayload {
	readonly itemId: string;
	readonly text: string;
	readonly metadata: CanonicalContextMetadata;
	readonly readableProjection?: TranscriptReadableProjection;
}

export interface DisplayActivityTranscriptPayload {
	readonly activityType: TranscriptDisplayActivityType;
	readonly text?: string;
	readonly callId?: string;
	readonly toolName?: string;
	readonly status?: string;
	readonly metadata?: Readonly<Record<string, TranscriptJsonValue>>;
}

export interface AppendTranscriptDisplayActivityInput {
	readonly sessionId: string;
	readonly eventId: string;
	readonly turnId?: string;
	readonly activityType: TranscriptDisplayActivityType;
	readonly text?: string;
	readonly callId?: string;
	readonly toolName?: string;
	readonly status?: string;
	readonly metadata?: Readonly<Record<string, TranscriptJsonValue>>;
	readonly createdAt: string;
}

export interface AppendCompactionActivityInput {
	readonly checkpointId: string;
	readonly fingerprint: string;
	readonly activity: AppendTranscriptDisplayActivityInput;
}

export interface TurnLifecycleTranscriptPayload {
	readonly interruptionReason?: TurnInterruptionReason;
	readonly phase: TranscriptLifecyclePhase;
	readonly errorCode?: RuntimeErrorCode;
	readonly message?: string;
	readonly additionalDetails?: string;
	readonly errorContext?: ErrorContext;
	readonly usage?: ProviderUsage;
	readonly diagnostics?: Readonly<Record<string, TranscriptJsonValue>>;
}

export interface RollbackTranscriptPayload {
	readonly removedTurnIds: readonly string[];
	readonly boundaryEventId?: string;
	readonly reason: "user_requested" | "retry" | "recovery" | "legacy";
}

export interface CompactionTranscriptPayload {
	readonly windowId: string;
	readonly sourceEventId?: string;
	readonly sourceProviderIndex: number;
	readonly replacement: readonly CanonicalConversationItem[];
	readonly summary: string;
	readonly metadata?: Readonly<Record<string, TranscriptJsonValue>>;
}

export interface OpaqueLegacyTranscriptPayload {
	readonly sourceKind: TranscriptLegacySourceKind;
	readonly sourceIdentity: string;
	readonly rawPayload: string;
	readonly errorCode: TranscriptLegacyErrorCode;
}

export interface TranscriptEventPayloadByType {
	readonly user_input: UserInputTranscriptPayload;
	readonly assistant_output: AssistantOutputTranscriptPayload;
	readonly assistant_tool_call_batch: AssistantToolCallBatchTranscriptPayload;
	readonly tool_result: ToolResultTranscriptPayload;
	readonly context: ContextTranscriptPayload;
	readonly display_activity: DisplayActivityTranscriptPayload;
	readonly turn_lifecycle: TurnLifecycleTranscriptPayload;
	readonly rollback: RollbackTranscriptPayload;
	readonly compaction: CompactionTranscriptPayload;
	readonly opaque_legacy: OpaqueLegacyTranscriptPayload;
}

export type TranscriptEventEnvelope<Type extends TranscriptEventType = TranscriptEventType> = {
	readonly [Kind in Type]: Readonly<{
		readonly schemaVersion: typeof TRANSCRIPT_EVENT_SCHEMA_VERSION;
		readonly sequenceNo: number;
		readonly sessionId: string;
		readonly eventId: string;
		readonly turnId?: string;
		readonly eventType: Kind;
		readonly providerIndex?: number;
		readonly modelVisible: boolean;
		readonly createdAt: string;
		readonly payload: TranscriptEventPayloadByType[Kind];
	}>;
}[Type];

export type TranscriptEventAppendInput<Type extends TranscriptEventType = TranscriptEventType> = {
	readonly [Kind in Type]: Omit<
		TranscriptEventEnvelope<Kind>,
		"sequenceNo" | "providerIndex"
	>;
}[Type];

export class TranscriptEventContractError extends Error {
	readonly code = "transcript_event_invalid" as const;
	readonly field: string;

	constructor(field: string) {
		super(`transcript_event_invalid: ${field}`);
		this.name = "TranscriptEventContractError";
		this.field = field;
	}
}

export function parseTranscriptEventEnvelope(value: unknown): TranscriptEventEnvelope {
	const event = record(value, "event");
	keys(event, [
		"schemaVersion",
		"sequenceNo",
		"sessionId",
		"eventId",
		"turnId",
		"eventType",
		"providerIndex",
		"modelVisible",
		"createdAt",
		"payload",
	], [
		"schemaVersion",
		"sequenceNo",
		"sessionId",
		"eventId",
		"eventType",
		"modelVisible",
		"createdAt",
		"payload",
	], "event");
	if (event.schemaVersion !== TRANSCRIPT_EVENT_SCHEMA_VERSION) invalid("schemaVersion");
	const sequenceNo = integer(event.sequenceNo, "sequenceNo", 1);
	const sessionId = identity(event.sessionId, "sessionId");
	const eventId = identity(event.eventId, "eventId");
	const turnId = optionalIdentity(event.turnId, "turnId");
	const eventType = transcriptEventType(event.eventType);
	const modelVisible = boolean(event.modelVisible, "modelVisible");
	const providerIndex = optionalInteger(event.providerIndex, "providerIndex", 0);
	if (modelVisible !== (providerIndex !== undefined)) invalid("providerIndex");
	const createdAt = boundedString(event.createdAt, "createdAt", CREATED_AT_MAX_CHARS, false);
	const payload = payloadFor(eventType, event.payload);
	return Object.freeze({
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sequenceNo,
		sessionId,
		eventId,
		...(turnId ? { turnId } : {}),
		eventType,
		...(providerIndex === undefined ? {} : { providerIndex }),
		modelVisible,
		createdAt,
		payload,
	}) as TranscriptEventEnvelope;
}

export function parseTranscriptEventAppendInput(value: unknown): TranscriptEventAppendInput {
	if (!isRecord(value) || "sequenceNo" in value || "providerIndex" in value) invalid("event");
	const modelVisible = value.modelVisible === true;
	const event = parseTranscriptEventEnvelope({
		...value,
		sequenceNo: 1,
		...(modelVisible ? { providerIndex: 0 } : {}),
	});
	return Object.freeze({
		schemaVersion: event.schemaVersion,
		sessionId: event.sessionId,
		eventId: event.eventId,
		...(event.turnId ? { turnId: event.turnId } : {}),
		eventType: event.eventType,
		modelVisible: event.modelVisible,
		createdAt: event.createdAt,
		payload: event.payload,
	}) as TranscriptEventAppendInput;
}

export function deterministicLegacyTranscriptEventId(input: Readonly<{
	readonly sessionId: string;
	readonly sourceKind: TranscriptLegacySourceKind;
	readonly sourceIdentity: string;
}>): string {
	const sessionId = identity(input.sessionId, "sessionId");
	const sourceIdentity = identity(input.sourceIdentity, "sourceIdentity");
	if (!LEGACY_SOURCE_KINDS.has(input.sourceKind)) invalid("sourceKind");
	const digest = createHash("sha256").update(stableJson([
		sessionId,
		input.sourceKind,
		sourceIdentity,
	])).digest("hex");
	return `legacy:${digest}`;
}

export function compareTranscriptEventOrder(
	left: Pick<TranscriptEventEnvelope, "sequenceNo" | "sessionId" | "eventId">,
	right: Pick<TranscriptEventEnvelope, "sequenceNo" | "sessionId" | "eventId">,
): number {
	if (left.sequenceNo !== right.sequenceNo) return left.sequenceNo - right.sequenceNo;
	const sessionOrder = left.sessionId.localeCompare(right.sessionId);
	return sessionOrder === 0 ? left.eventId.localeCompare(right.eventId) : sessionOrder;
}

const EVENT_TYPES = new Set<TranscriptEventType>([
	"user_input",
	"assistant_output",
	"assistant_tool_call_batch",
	"tool_result",
	"context",
	"display_activity",
	"turn_lifecycle",
	"rollback",
	"compaction",
	"opaque_legacy",
]);
const DISPLAY_ACTIVITY_TYPES = new Set<TranscriptDisplayActivityType>([
	"reasoning",
	"plan",
	"turn_completed",
	"approval_request",
	"approval_resolution",
	"clarification_request",
	"clarification_response",
	"shell",
	"error",
	"warning",
	"status",
	"file_change",
	"tool_activation",
	"context_baseline",
	"capability",
	"command_result",
	"web_search",
	"goal",
]);
const LIFECYCLE_PHASES = new Set<TranscriptLifecyclePhase>([
	"started",
	"completed",
	"failed",
	"interrupted",
]);
const LEGACY_SOURCE_KINDS = new Set<TranscriptLegacySourceKind>([
	"conversation_messages",
	"history_items",
	"turn_rollouts",
	"session_summaries",
]);
const LEGACY_ERROR_CODES = new Set<TranscriptLegacyErrorCode>([
	"invalid_json",
	"invalid_shape",
	"projection_failure",
	"source_conflict",
	"unsupported_shape",
]);

function payloadFor(
	eventType: TranscriptEventType,
	value: unknown,
): TranscriptEventPayloadByType[TranscriptEventType] {
	switch (eventType) {
		case "user_input": return userInput(value);
		case "assistant_output": return assistantOutput(value);
		case "assistant_tool_call_batch": return assistantToolCallBatch(value);
		case "tool_result": return toolResult(value);
		case "context": return context(value);
		case "display_activity": return displayActivity(value);
		case "turn_lifecycle": return turnLifecycle(value);
		case "rollback": return rollback(value);
		case "compaction": return compaction(value);
		case "opaque_legacy": return opaqueLegacy(value);
	}
}

function userInput(value: unknown): UserInputTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, ["text", "clientUserMessageId", "queueId", "source", "images", "readableProjection", "skillReferences"], [
		"text", "clientUserMessageId", "source",
	], "payload");
	if (payload.source !== "submit" && payload.source !== "steer"
		&& payload.source !== "queued" && payload.source !== "agent_mailbox"
		&& payload.source !== "task_notification" && payload.source !== "approval_resume" && payload.source !== "goal") {
		invalid("payload.source");
	}
	const images = payload.images === undefined ? undefined : canonicalImagePayload(payload.images);
	const queueId = optionalIdentity(payload.queueId, "payload.queueId");
	const readableProjection = optionalReadableProjection(payload.readableProjection);
	return Object.freeze({
		text: string(payload.text, "payload.text"),
		...(payload.skillReferences === undefined ? {} : { skillReferences: parseSkillReferences(payload.skillReferences) }),
		clientUserMessageId: identity(payload.clientUserMessageId, "payload.clientUserMessageId"),
		...(queueId ? { queueId } : {}),
		source: payload.source,
		...(images && images.length > 0 ? { images } : {}),
		...(readableProjection ? { readableProjection } : {}),
	});
}

function assistantOutput(value: unknown): AssistantOutputTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, ["text", "responseId", "providerState", "readableProjection"], ["text"], "payload");
	const responseId = optionalIdentity(payload.responseId, "payload.responseId");
	const providerState = optionalProviderState(payload.providerState);
	const readableProjection = optionalReadableProjection(payload.readableProjection);
	return Object.freeze({
		text: string(payload.text, "payload.text"),
		...(responseId ? { responseId } : {}),
		...(providerState ? { providerState } : {}),
		...(readableProjection ? { readableProjection } : {}),
	});
}

function assistantToolCallBatch(value: unknown): AssistantToolCallBatchTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, ["text", "calls", "responseId", "providerState", "readableProjection"], ["text", "calls"], "payload");
	if (!Array.isArray(payload.calls) || payload.calls.length < 1
		|| payload.calls.length > TRANSCRIPT_EVENT_MAX_BATCH_ITEMS) {
		invalid("payload.calls");
	}
	const calls = Object.freeze(payload.calls.map((call, index) => toolCall(call, index)));
	if (new Set(calls.map((call) => call.callId)).size !== calls.length) invalid("payload.calls");
	const responseId = optionalIdentity(payload.responseId, "payload.responseId");
	const providerState = optionalProviderState(payload.providerState);
	const readableProjection = optionalReadableProjection(payload.readableProjection);
	return Object.freeze({
		text: string(payload.text, "payload.text"),
		calls,
		...(responseId ? { responseId } : {}),
		...(providerState ? { providerState } : {}),
		...(readableProjection ? { readableProjection } : {}),
	});
}

function toolResult(value: unknown): ToolResultTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, ["result", "summary", "errorKind", "metadata", "readableProjection"], ["result", "summary"], "payload");
	const result = record(payload.result, "payload.result");
	keys(result, ["callId", "toolName", "output", "success", "images"], [
		"callId", "toolName", "output", "success",
	], "payload.result");
	const errorKind = optionalIdentity(payload.errorKind, "payload.errorKind");
	const metadata = optionalJsonRecord(payload.metadata, "payload.metadata");
	const readableProjection = optionalReadableProjection(payload.readableProjection);
	return Object.freeze({
		result: Object.freeze({
			callId: identity(result.callId, "payload.result.callId"),
			toolName: identity(result.toolName, "payload.result.toolName"),
			output: string(result.output, "payload.result.output"),
			success: boolean(result.success, "payload.result.success"),
			...(result.images === undefined ? {} : { images: canonicalImagePayload(result.images) }),
		}),
		summary: string(payload.summary, "payload.summary"),
		...(errorKind ? { errorKind } : {}),
		...(metadata ? { metadata } : {}),
		...(readableProjection ? { readableProjection } : {}),
	});
}

function context(value: unknown): ContextTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, ["itemId", "text", "metadata", "readableProjection"], ["itemId", "text", "metadata"], "payload");
	const readableProjection = optionalReadableProjection(payload.readableProjection);
	return Object.freeze({
		itemId: identity(payload.itemId, "payload.itemId"),
		text: string(payload.text, "payload.text"),
		metadata: contextMetadata(payload.metadata),
		...(readableProjection ? { readableProjection } : {}),
	});
}

function optionalReadableProjection(value: unknown): TranscriptReadableProjection | undefined {
	if (value === undefined) return undefined;
	const projection = record(value, "payload.readableProjection");
	keys(projection, [
		"hidden", "searchVisible", "itemId", "createdAt", "assistantPreambleVisible", "toolCallItemIds",
	], [], "payload.readableProjection");
	const hidden = projection.hidden === undefined
		? undefined
		: boolean(projection.hidden, "payload.readableProjection.hidden");
	const searchVisible = projection.searchVisible === undefined
		? undefined
		: boolean(projection.searchVisible, "payload.readableProjection.searchVisible");
	const itemId = optionalIdentity(projection.itemId, "payload.readableProjection.itemId");
	const createdAt = projection.createdAt === null
		? null
		: optionalIdentity(projection.createdAt, "payload.readableProjection.createdAt");
	const assistantPreambleVisible = projection.assistantPreambleVisible === undefined
		? undefined
		: boolean(
			projection.assistantPreambleVisible,
			"payload.readableProjection.assistantPreambleVisible",
		);
	let toolCallItemIds: Readonly<Record<string, string>> | undefined;
	if (projection.toolCallItemIds !== undefined) {
		const raw = record(projection.toolCallItemIds, "payload.readableProjection.toolCallItemIds");
		const entries = Object.entries(raw).map(([callId, item]) => [
			identity(callId, "payload.readableProjection.toolCallItemIds.callId"),
			identity(item, "payload.readableProjection.toolCallItemIds.itemId"),
		] as const);
		toolCallItemIds = Object.freeze(Object.fromEntries(entries));
	}
	return Object.freeze({
		...(hidden === undefined ? {} : { hidden }),
		...(searchVisible === undefined ? {} : { searchVisible }),
		...(itemId ? { itemId } : {}),
		...(createdAt === undefined ? {} : { createdAt }),
		...(assistantPreambleVisible === undefined ? {} : { assistantPreambleVisible }),
		...(toolCallItemIds ? { toolCallItemIds } : {}),
	});
}

function displayActivity(value: unknown): DisplayActivityTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, ["activityType", "text", "callId", "toolName", "status", "metadata"], [
		"activityType",
	], "payload");
	if (!DISPLAY_ACTIVITY_TYPES.has(payload.activityType as TranscriptDisplayActivityType)) {
		invalid("payload.activityType");
	}
	const text = optionalString(payload.text, "payload.text");
	const callId = optionalIdentity(payload.callId, "payload.callId");
	const toolName = optionalIdentity(payload.toolName, "payload.toolName");
	const status = optionalIdentity(payload.status, "payload.status");
	const metadata = optionalJsonRecord(payload.metadata, "payload.metadata");
	if (payload.activityType === "goal") {
		if (!metadata || !["create", "edit", "status", "clear", "usage", "round"].includes(String(metadata.goal_operation))) invalid("payload.metadata.goal_operation");
		if (metadata.goal_snapshot !== null) parseSessionGoal(metadata.goal_snapshot);
	}
	return Object.freeze({
		activityType: payload.activityType as TranscriptDisplayActivityType,
		...(text === undefined ? {} : { text }),
		...(callId ? { callId } : {}),
		...(toolName ? { toolName } : {}),
		...(status ? { status } : {}),
		...(metadata ? { metadata } : {}),
	});
}

function turnLifecycle(value: unknown): TurnLifecycleTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, ["phase", "interruptionReason", "errorCode", "message", "additionalDetails", "errorContext", "usage", "diagnostics"], ["phase"], "payload");
	if (!LIFECYCLE_PHASES.has(payload.phase as TranscriptLifecyclePhase)) invalid("payload.phase");
	if (payload.interruptionReason !== undefined && !isTurnInterruptionReason(payload.interruptionReason)) invalid("payload.interruptionReason");
	const errorCode = optionalIdentity(payload.errorCode, "payload.errorCode");
	if (errorCode !== undefined && !isRuntimeErrorCode(errorCode)) {
		invalid("payload.errorCode");
	}
	const message = optionalString(payload.message, "payload.message");
	const additionalDetails = payload.additionalDetails === undefined
		? undefined
		: sanitizeRuntimeErrorDetail(boundedString(
			payload.additionalDetails,
			"payload.additionalDetails",
			1_000,
			false,
		));
	const usage = optionalNumberRecord(payload.usage, "payload.usage");
	const diagnostics = optionalJsonRecord(payload.diagnostics, "payload.diagnostics");
	const errorContext = readErrorContext(payload.errorContext);
	if ((payload.phase === "failed" || payload.phase === "interrupted") && !message) {
		invalid("payload.message");
	}
	return Object.freeze({
		phase: payload.phase as TranscriptLifecyclePhase,
		...(isTurnInterruptionReason(payload.interruptionReason) ? { interruptionReason: payload.interruptionReason } : {}),
		...(errorCode ? { errorCode } : {}),
		...(message === undefined ? {} : { message }),
		...(additionalDetails === undefined ? {} : { additionalDetails }),
		...(usage ? { usage } : {}),
		...(diagnostics ? { diagnostics } : {}),
		...(errorContext ? { errorContext } : {}),
	});
}

function rollback(value: unknown): RollbackTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, ["removedTurnIds", "boundaryEventId", "reason"], [
		"removedTurnIds", "reason",
	], "payload");
	if (!Array.isArray(payload.removedTurnIds)
		|| payload.removedTurnIds.length < 1
		|| payload.removedTurnIds.length > TRANSCRIPT_EVENT_MAX_BATCH_ITEMS) {
		invalid("payload.removedTurnIds");
	}
	if (payload.reason !== "user_requested" && payload.reason !== "retry"
		&& payload.reason !== "recovery" && payload.reason !== "legacy") {
		invalid("payload.reason");
	}
	const removedTurnIds = Object.freeze(payload.removedTurnIds.map((id) => (
		identity(id, "payload.removedTurnIds")
	)));
	if (new Set(removedTurnIds).size !== removedTurnIds.length) invalid("payload.removedTurnIds");
	const boundaryEventId = optionalIdentity(payload.boundaryEventId, "payload.boundaryEventId");
	return Object.freeze({
		removedTurnIds,
		...(boundaryEventId ? { boundaryEventId } : {}),
		reason: payload.reason,
	});
}

function compaction(value: unknown): CompactionTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, [
		"windowId", "sourceEventId", "sourceProviderIndex", "replacement", "summary", "metadata",
	], [
		"windowId", "sourceProviderIndex", "replacement", "summary",
	], "payload");
	if (!Array.isArray(payload.replacement)
		|| payload.replacement.length > TRANSCRIPT_EVENT_MAX_BATCH_ITEMS) {
		invalid("payload.replacement");
	}
	const sourceEventId = optionalIdentity(payload.sourceEventId, "payload.sourceEventId");
	const replacement = Object.freeze(payload.replacement.map((item, index) => (
		conversationItem(item, `payload.replacement.${index}`)
	)));
	const metadata = optionalJsonRecord(payload.metadata, "payload.metadata");
	return Object.freeze({
		windowId: identity(payload.windowId, "payload.windowId"),
		...(sourceEventId ? { sourceEventId } : {}),
		sourceProviderIndex: integer(payload.sourceProviderIndex, "payload.sourceProviderIndex", 0),
		replacement,
		summary: string(payload.summary, "payload.summary"),
		...(metadata ? { metadata } : {}),
	});
}

function opaqueLegacy(value: unknown): OpaqueLegacyTranscriptPayload {
	const payload = record(value, "payload");
	keys(payload, ["sourceKind", "sourceIdentity", "rawPayload", "errorCode"], [
		"sourceKind", "sourceIdentity", "rawPayload", "errorCode",
	], "payload");
	if (!LEGACY_SOURCE_KINDS.has(payload.sourceKind as TranscriptLegacySourceKind)) {
		invalid("payload.sourceKind");
	}
	if (!LEGACY_ERROR_CODES.has(payload.errorCode as TranscriptLegacyErrorCode)) {
		invalid("payload.errorCode");
	}
	return Object.freeze({
		sourceKind: payload.sourceKind as TranscriptLegacySourceKind,
		sourceIdentity: identity(payload.sourceIdentity, "payload.sourceIdentity"),
		rawPayload: string(payload.rawPayload, "payload.rawPayload"),
		errorCode: payload.errorCode as TranscriptLegacyErrorCode,
	});
}

function conversationItem(value: unknown, field: string): CanonicalConversationItem {
	const item = record(value, field);
	const type = item.type;
	if (type === "user") {
		keys(item, ["type", "text", "images"], ["type", "text"], field);
		const images = item.images === undefined ? undefined : canonicalImagePayload(item.images);
		return Object.freeze({
			type,
			text: string(item.text, `${field}.text`),
			...(images && images.length > 0 ? { images } : {}),
		});
	}
	if (type === "assistant") {
		keys(item, ["type", "text", "providerState"], ["type", "text"], field);
		const providerState = optionalProviderState(item.providerState);
		return Object.freeze({
			type,
			text: string(item.text, `${field}.text`),
			...(providerState ? { providerState } : {}),
		});
	}
	if (type === "assistant_tool_calls") {
		keys(item, ["type", "text", "calls", "responseId", "providerState"], [
			"type", "text", "calls",
		], field);
		if (!Array.isArray(item.calls) || item.calls.length < 1
			|| item.calls.length > TRANSCRIPT_EVENT_MAX_BATCH_ITEMS) invalid(`${field}.calls`);
		const calls = Object.freeze(item.calls.map((call, index) => toolCall(call, index, `${field}.calls`)));
		const responseId = optionalIdentity(item.responseId, `${field}.responseId`);
		const providerState = optionalProviderState(item.providerState);
		return Object.freeze({
			type,
			text: string(item.text, `${field}.text`),
			calls,
			...(responseId ? { responseId } : {}),
			...(providerState ? { providerState } : {}),
		});
	}
	if (type === "tool_result") {
		keys(item, ["type", "callId", "toolName", "output", "success", "images", "toolDiscoveries"], [
			"type", "callId", "toolName", "output", "success",
		], field);
		return Object.freeze({
			type,
			callId: identity(item.callId, `${field}.callId`),
			toolName: identity(item.toolName, `${field}.toolName`),
			output: string(item.output, `${field}.output`),
			success: boolean(item.success, `${field}.success`),
			...(item.toolDiscoveries === undefined ? {} : {
				toolDiscoveries: parseToolDiscoveries({ version: 1, tools: item.toolDiscoveries }),
			}),
			...(item.images === undefined ? {} : { images: canonicalImagePayload(item.images) }),
		});
	}
	if (type === "context") {
		keys(item, ["type", "text", "metadata"], ["type", "text", "metadata"], field);
		return Object.freeze({
			type,
			text: string(item.text, `${field}.text`),
			metadata: contextMetadata(item.metadata),
		});
	}
	return invalid(field);
}

function toolCall(value: unknown, index: number, field = "payload.calls"): CanonicalToolCall {
	const call = record(value, `${field}.${index}`);
	keys(call, ["callId", "name", "argumentsJson"], [
		"callId", "name", "argumentsJson",
	], `${field}.${index}`);
	const argumentsJson = string(call.argumentsJson, `${field}.${index}.argumentsJson`);
	try {
		jsonValue(JSON.parse(argumentsJson) as unknown, `${field}.${index}.argumentsJson`, 0);
	} catch (error) {
		if (error instanceof TranscriptEventContractError) throw error;
		invalid(`${field}.${index}.argumentsJson`);
	}
	return Object.freeze({
		callId: identity(call.callId, `${field}.${index}.callId`),
		name: identity(call.name, `${field}.${index}.name`),
		argumentsJson,
	});
}

function contextMetadata(value: unknown): CanonicalContextMetadata {
	const metadata = record(value, "payload.metadata");
	keys(metadata, [
		"kind", "role", "cacheClass", "durability", "scope", "sourceId", "contentSha256",
		"contentLength", "supersedesItemId", "tombstone",
	], [
		"kind", "cacheClass", "durability", "scope", "sourceId", "contentSha256", "contentLength",
	], "payload.metadata");
	if (!CONTEXT_KINDS.has(metadata.kind as CanonicalContextMetadata["kind"])) {
		invalid("payload.metadata.kind");
	}
	if (metadata.role !== undefined && metadata.role !== "developer" && metadata.role !== "user") {
		invalid("payload.metadata.role");
	}
	if (metadata.cacheClass !== "static" && metadata.cacheClass !== "dynamic"
		&& metadata.cacheClass !== "ephemeral") invalid("payload.metadata.cacheClass");
	if (metadata.durability !== "persistent") invalid("payload.metadata.durability");
	if (metadata.scope !== "session" && metadata.scope !== "turn"
		&& metadata.scope !== "transcript") invalid("payload.metadata.scope");
	if (typeof metadata.contentSha256 !== "string" || !HASH_PATTERN.test(metadata.contentSha256)) {
		invalid("payload.metadata.contentSha256");
	}
	const supersedesItemId = optionalIdentity(
		metadata.supersedesItemId,
		"payload.metadata.supersedesItemId",
	);
	if (metadata.tombstone !== undefined && metadata.tombstone !== true) {
		invalid("payload.metadata.tombstone");
	}
	return Object.freeze({
		kind: metadata.kind as CanonicalContextMetadata["kind"],
		...(metadata.role ? { role: metadata.role as "developer" | "user" } : {}),
		cacheClass: metadata.cacheClass,
		durability: "persistent",
		scope: metadata.scope,
		sourceId: identity(metadata.sourceId, "payload.metadata.sourceId"),
		contentSha256: metadata.contentSha256,
		contentLength: integer(metadata.contentLength, "payload.metadata.contentLength", 0),
		...(supersedesItemId ? { supersedesItemId } : {}),
		...(metadata.tombstone === true ? { tombstone: true } : {}),
	});
}

function optionalProviderState(value: unknown): ProviderReplayState | undefined {
	if (value === undefined) return undefined;
	const state = record(value, "payload.providerState");
	keys(
		state,
		["provider", "value", "tokenEstimate"],
		["provider", "value"],
		"payload.providerState",
	);
	if (!isProviderRouteId(state.provider)) {
		invalid("payload.providerState.provider");
	}
	return Object.freeze({
		provider: state.provider as ProviderReplayState["provider"],
		value: jsonRecord(state.value, "payload.providerState.value"),
		...(state.tokenEstimate === undefined ? {} : {
			tokenEstimate: integer(state.tokenEstimate, "payload.providerState.tokenEstimate", 0),
		}),
	});
}

function canonicalImagePayload(value: unknown): readonly CanonicalImage[] {
	if (!Array.isArray(value)) invalid("payload.images");
	try {
		return canonicalImages(value as readonly CanonicalImage[], "transcript event");
	} catch {
		return invalid("payload.images");
	}
}

function optionalNumberRecord(value: unknown, field: string): ProviderUsage | undefined {
	if (value === undefined) return undefined;
	const usage = record(value, field);
	const normalized: Record<string, number> = {};
	for (const [key, item] of Object.entries(usage)) {
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0) invalid(field);
		normalized[key] = item;
	}
	return Object.freeze(normalized);
}

function optionalJsonRecord(
	value: unknown,
	field: string,
): Readonly<Record<string, TranscriptJsonValue>> | undefined {
	return value === undefined ? undefined : jsonRecord(value, field);
}

function jsonRecord(value: unknown, field: string): Readonly<Record<string, TranscriptJsonValue>> {
	const normalized = jsonValue(value, field, 0);
	if (!isRecord(normalized)) invalid(field);
	return normalized as Readonly<Record<string, TranscriptJsonValue>>;
}

function jsonValue(value: unknown, field: string, depth: number): TranscriptJsonValue {
	if (depth > 64) return invalid(field);
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return invalid(field);
		return value;
	}
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item) => jsonValue(item, field, depth + 1)));
	}
	if (!isRecord(value)) return invalid(field);
	const normalized: Record<string, TranscriptJsonValue> = {};
	for (const [key, item] of Object.entries(value)) {
		normalized[key] = jsonValue(item, field, depth + 1);
	}
	return Object.freeze(normalized);
}

function transcriptEventType(value: unknown): TranscriptEventType {
	if (!EVENT_TYPES.has(value as TranscriptEventType)) invalid("eventType");
	return value as TranscriptEventType;
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) invalid(field);
	return value;
}

function keys(
	value: Readonly<Record<string, unknown>>,
	allowed: readonly string[],
	required: readonly string[],
	field: string,
): void {
	const allowedKeys = new Set(allowed);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) invalid(field);
	if (required.some((key) => !(key in value))) invalid(field);
}

function identity(value: unknown, field: string): string {
	return boundedString(value, field, IDENTITY_MAX_CHARS, false);
}

function optionalIdentity(value: unknown, field: string): string | undefined {
	return value === undefined ? undefined : identity(value, field);
}

function string(value: unknown, field: string): string {
	if (typeof value !== "string") invalid(field);
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	return value === undefined ? undefined : string(value, field);
}

function boundedString(value: unknown, field: string, maxChars: number, allowEmpty: boolean): string {
	if (typeof value !== "string" || value.length > maxChars || (!allowEmpty && !value.trim())) {
		invalid(field);
	}
	return value;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") invalid(field);
	return value;
}

function integer(value: unknown, field: string, minimum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(field);
	return Number(value);
}

function optionalInteger(value: unknown, field: string, minimum: number): number | undefined {
	return value === undefined ? undefined : integer(value, field, minimum);
}

function invalid(field: string): never {
	throw new TranscriptEventContractError(field);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

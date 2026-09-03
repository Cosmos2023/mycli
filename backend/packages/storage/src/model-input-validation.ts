import {
	isProviderRouteId,
	manifestLogicalInputSha256,
	manifestTimelineLogicalInputSha256,
	modelInputSha256,
} from "@mycli/core";
import type {
	CanonicalContextMetadata,
	CanonicalConversationItem,
	InstructionFragment,
	InstructionSnapshot,
	ModelContextEvent,
	ModelInputReference,
	ProviderInputTimelineEvent,
	ProviderRequest,
	ProviderRequestConfig,
	ProviderRequestManifest,
	ProviderReplayState,
	ToolDefinition,
	ToolSetSnapshot,
} from "@mycli/core";
import { StorageFailure } from "./session-store.ts";
import { stableJson } from "./stable-json.ts";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODEL_INPUT_JSON_MAX_CHARS = 32 * 1024 * 1024;
const INSTRUCTION_CONTENT_MAX_CHARS = 2 * 1024 * 1024;
const CONTEXT_CONTENT_MAX_CHARS = 2 * 1024 * 1024;
const TEXT_FIELD_MAX_CHARS = 8_192;
const TOOL_DESCRIPTION_MAX_CHARS = 65_536;
const LIFECYCLE_PAYLOAD_MAX_CHARS = 16_384;

const PROTOCOLS = new Set(["responses", "chat_completions", "anthropic_messages"]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const FRAGMENT_KINDS = new Set([
	"collaboration_mode",
	"permissions",
	"tool_exposure",
	"skill_catalog",
	"skill_instructions",
	"workspace_instructions",
	"environment_context",
	"conversation_context",
	"compaction_rehydration",
	"memory",
	"plan",
	"hook_context",
	"runtime_policy_reminder",
	"runtime_context_reminder",
	"subagent_context",
]);
const REFERENCE_KINDS = new Set([
	"instruction_snapshot",
	"tool_set_snapshot",
	"context_event",
	"conversation_item",
	"provider_native_item",
	"provider_timeline_event",
	"compaction_boundary",
]);
const CONTEXT_KINDS = new Set([
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

const TIMELINE_EVENT_KINDS = new Set([
	"window_boundary",
	"conversation_item",
	"context_update",
	"context_tombstone",
]);

const TIMELINE_BOUNDARIES = new Set([
	"bootstrap",
	"legacy_bootstrap",
	"compaction",
	"source_reset",
]);

export type ProviderStepLifecycleState =
	| "prepared"
	| "dispatch_started"
	| "acknowledged"
	| "failed"
	| "unknown";

export type ProviderStepLifecyclePayload = Readonly<
	Record<string, string | number | boolean | null>
>;

export interface ProviderStepLifecycleEvent {
	readonly eventId: string;
	readonly requestId: string;
	readonly sessionId: string;
	readonly state: ProviderStepLifecycleState;
	readonly payload: ProviderStepLifecyclePayload;
	readonly createdAt: string;
}

export function normalizeInstructionSnapshot(value: InstructionSnapshot): InstructionSnapshot {
	const record = normalizedRecord(value, "instruction snapshot");
	assertKeys(record, [
		"snapshotId", "version", "source", "content", "contentSha256", "createdAt",
	], ["snapshotId", "version", "source", "content", "contentSha256", "createdAt"], "instruction snapshot");
	const content = boundedString(record.content, "instruction snapshot content", INSTRUCTION_CONTENT_MAX_CHARS, true);
	const snapshot: InstructionSnapshot = {
		snapshotId: identifier(record.snapshotId, "instruction snapshot"),
		version: boundedString(record.version, "instruction snapshot version", TEXT_FIELD_MAX_CHARS, true),
		source: boundedString(record.source, "instruction snapshot source", TEXT_FIELD_MAX_CHARS, true),
		content,
		contentSha256: sha256(record.contentSha256, "instruction snapshot content"),
		createdAt: timestamp(record.createdAt, "instruction snapshot"),
	};
	if (snapshot.contentSha256 !== modelInputSha256(content)) {
		throw invalid("instruction snapshot content hash does not match");
	}
	return Object.freeze(snapshot);
}

export function normalizeToolSetSnapshot(value: ToolSetSnapshot): ToolSetSnapshot {
	const record = normalizedRecord(value, "tool-set snapshot");
	assertKeys(record, ["snapshotId", "tools", "contentSha256", "createdAt"], [
		"snapshotId", "tools", "contentSha256", "createdAt",
	], "tool-set snapshot");
	if (!Array.isArray(record.tools)) throw invalid("tool-set snapshot tools are invalid");
	const tools = Object.freeze(record.tools.map((tool) => normalizeToolDefinition(tool)));
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const tool of tools) {
		if (ids.has(tool.id) || names.has(tool.name)) {
			throw invalid("tool-set snapshot contains duplicate tools");
		}
		ids.add(tool.id);
		names.add(tool.name);
	}
	const snapshot: ToolSetSnapshot = {
		snapshotId: identifier(record.snapshotId, "tool-set snapshot"),
		tools,
		contentSha256: sha256(record.contentSha256, "tool-set snapshot content"),
		createdAt: timestamp(record.createdAt, "tool-set snapshot"),
	};
	if (snapshot.contentSha256 !== modelInputSha256(tools)) {
		throw invalid("tool-set snapshot content hash does not match");
	}
	return Object.freeze(snapshot);
}

export function normalizeModelContextEvent(value: ModelContextEvent): ModelContextEvent {
	const record = normalizedRecord(value, "model context event");
	assertKeys(record, [
		"eventId", "sessionId", "turnId", "providerStep", "sectionKey", "fragment",
		"supersedesEventId", "tombstone", "createdAt",
	], [
		"eventId", "sessionId", "turnId", "providerStep", "sectionKey", "tombstone", "createdAt",
	], "model context event");
	if (typeof record.tombstone !== "boolean") throw invalid("model context tombstone is invalid");
	const fragment = record.fragment === undefined
		? undefined
		: normalizeInstructionFragment(record.fragment);
	if (record.tombstone === (fragment !== undefined)) {
		throw invalid(record.tombstone
			? "model context tombstone must not contain a fragment"
			: "model context event is missing its fragment");
	}
	return Object.freeze({
		eventId: identifier(record.eventId, "model context event"),
		sessionId: identifier(record.sessionId, "model context session"),
		turnId: identifier(record.turnId, "model context turn"),
		providerStep: nonNegativeInteger(record.providerStep, "model context provider step"),
		sectionKey: identifier(record.sectionKey, "model context section"),
		...(fragment ? { fragment } : {}),
		...(record.supersedesEventId === undefined ? {} : {
			supersedesEventId: identifier(record.supersedesEventId, "superseded model context event"),
		}),
		tombstone: record.tombstone,
		createdAt: timestamp(record.createdAt, "model context event"),
	});
}

export function normalizeProviderInputTimelineEvent(
	value: ProviderInputTimelineEvent,
): ProviderInputTimelineEvent {
	const record = normalizedRecord(value, "provider input timeline event");
	assertKeys(record, [
		"eventId", "sessionId", "windowId", "turnId", "providerStep", "kind", "item",
		"sourceIndex", "modelContextEventId", "boundary", "contentSha256", "createdAt",
	], [
		"eventId", "sessionId", "windowId", "turnId", "providerStep", "kind",
		"contentSha256", "createdAt",
	], "provider input timeline event");
	if (typeof record.kind !== "string" || !TIMELINE_EVENT_KINDS.has(record.kind)) {
		throw invalid("provider input timeline event kind is invalid");
	}
	const kind = record.kind as ProviderInputTimelineEvent["kind"];
	const boundary = record.boundary;
	const item = record.item === undefined ? undefined : normalizeCanonicalItem(record.item);
	const sourceIndex = record.sourceIndex === undefined
		? undefined
		: nonNegativeInteger(record.sourceIndex, "provider input timeline source index");
	const modelContextEventId = record.modelContextEventId === undefined
		? undefined
		: identifier(record.modelContextEventId, "provider input timeline context event");
	if (kind === "window_boundary") {
		if (typeof boundary !== "string" || !TIMELINE_BOUNDARIES.has(boundary)
			|| item !== undefined || sourceIndex !== undefined || modelContextEventId !== undefined) {
			throw invalid("provider input timeline window boundary is invalid");
		}
	} else if (boundary !== undefined || item === undefined) {
		throw invalid("provider input timeline item event is invalid");
	}
	if (kind === "conversation_item" && (sourceIndex === undefined || modelContextEventId !== undefined)) {
		throw invalid("provider input timeline conversation source is invalid");
	}
	if ((kind === "context_update" || kind === "context_tombstone")
		&& (sourceIndex !== undefined || modelContextEventId === undefined || item?.type !== "context")) {
		throw invalid("provider input timeline context source is invalid");
	}
	if (kind === "context_update" && item?.type === "context" && item.metadata.tombstone === true) {
		throw invalid("provider input timeline context update is marked as a tombstone");
	}
	if (kind === "context_tombstone" && item?.type === "context" && item.metadata.tombstone !== true) {
		throw invalid("provider input timeline context tombstone is not marked inactive");
	}
	const event: ProviderInputTimelineEvent = Object.freeze({
		eventId: identifier(record.eventId, "provider input timeline event"),
		sessionId: identifier(record.sessionId, "provider input timeline session"),
		windowId: identifier(record.windowId, "provider input timeline window"),
		turnId: identifier(record.turnId, "provider input timeline turn"),
		providerStep: nonNegativeInteger(record.providerStep, "provider input timeline provider step"),
		kind,
		...(item ? { item } : {}),
		...(sourceIndex === undefined ? {} : { sourceIndex }),
		...(modelContextEventId === undefined ? {} : { modelContextEventId }),
		...(boundary === undefined ? {} : {
			boundary: boundary as NonNullable<ProviderInputTimelineEvent["boundary"]>,
		}),
		contentSha256: sha256(record.contentSha256, "provider input timeline content"),
		createdAt: timestamp(record.createdAt, "provider input timeline event"),
	});
	const expectedHash = event.item === undefined
		? modelInputSha256({ window_id: event.windowId, boundary: event.boundary })
		: modelInputSha256(event.item);
	if (event.contentSha256 !== expectedHash) {
		throw invalid("provider input timeline content hash does not match");
	}
	return event;
}

export function normalizeProviderRequestManifest(
	value: ProviderRequestManifest,
): ProviderRequestManifest {
	const record = normalizedRecord(value, "provider request manifest");
	assertKeys(record, [
		"schemaVersion", "requestId", "sessionId", "turnId", "providerStep", "providerConfig",
		"instructionSnapshotId", "toolSetSnapshotId", "orderedItems", "requestSignature",
		"logicalInputSha256", "contextPrefixSha256", "previousManifestId", "boundary", "createdAt",
		"timelineWindowId", "timelineEventIds", "requestConfigurationSha256",
		"bootstrapPrefixSha256", "timelineSha256", "commonPrefixItemCount",
		"timelineEventCount", "timelinePrefixSha256",
	], [
		"schemaVersion", "requestId", "sessionId", "turnId", "providerStep", "providerConfig",
		"instructionSnapshotId", "toolSetSnapshotId", "requestSignature",
		"logicalInputSha256", "contextPrefixSha256", "createdAt",
	], "provider request manifest");
	if (record.schemaVersion !== 1 && record.schemaVersion !== 2 && record.schemaVersion !== 3) {
		throw invalid("provider request manifest version is unsupported");
	}
	if ((record.schemaVersion === 1 || record.schemaVersion === 2)
		&& !Array.isArray(record.orderedItems)) {
		throw invalid("provider request manifest order is invalid");
	}
	if (record.schemaVersion === 3
		&& (record.orderedItems !== undefined || record.timelineEventIds !== undefined)) {
		throw invalid("provider request manifest v3 repeats timeline prefix arrays");
	}
	const boundary = record.boundary;
	if (boundary !== undefined && boundary !== "bootstrap"
		&& boundary !== "legacy_bootstrap" && boundary !== "continuation_reset"
		&& boundary !== "compaction" && boundary !== "source_reset") {
		throw invalid("provider request manifest boundary is invalid");
	}
	const v2TimelineFields = [
		record.timelineWindowId,
		record.timelineEventIds,
		record.requestConfigurationSha256,
		record.bootstrapPrefixSha256,
		record.timelineSha256,
		record.commonPrefixItemCount,
	];
	const v3TimelineFields = [
		record.timelineWindowId,
		record.timelineEventCount,
		record.timelinePrefixSha256,
		record.requestConfigurationSha256,
		record.bootstrapPrefixSha256,
		record.timelineSha256,
		record.commonPrefixItemCount,
	];
	if (record.schemaVersion === 1
		&& [...v2TimelineFields, ...v3TimelineFields].some((field) => field !== undefined)) {
		throw invalid("provider request manifest v1 contains timeline fields");
	}
	if (record.schemaVersion === 2 && v2TimelineFields.some((field) => field === undefined)) {
		throw invalid("provider request manifest v2 is missing timeline fields");
	}
	if (record.schemaVersion === 2 && !Array.isArray(record.timelineEventIds)) {
		throw invalid("provider request manifest timeline order is invalid");
	}
	if (record.schemaVersion === 3 && v3TimelineFields.some((field) => field === undefined)) {
		throw invalid("provider request manifest v3 is missing compact timeline fields");
	}
	const normalized = {
		schemaVersion: record.schemaVersion,
		requestId: identifier(record.requestId, "provider request"),
		sessionId: identifier(record.sessionId, "provider request session"),
		turnId: identifier(record.turnId, "provider request turn"),
		providerStep: nonNegativeInteger(record.providerStep, "provider request step"),
		providerConfig: normalizeProviderConfig(record.providerConfig),
		instructionSnapshotId: identifier(record.instructionSnapshotId, "instruction snapshot"),
		toolSetSnapshotId: identifier(record.toolSetSnapshotId, "tool-set snapshot"),
		...(record.schemaVersion === 1 || record.schemaVersion === 2 ? {
			orderedItems: Object.freeze((record.orderedItems as readonly unknown[])
				.map(normalizeModelInputReference)),
		} : {}),
		requestSignature: boundedString(record.requestSignature, "provider request signature", TEXT_FIELD_MAX_CHARS, true),
		logicalInputSha256: sha256(record.logicalInputSha256, "logical input"),
		contextPrefixSha256: sha256(record.contextPrefixSha256, "context prefix"),
		...(record.previousManifestId === undefined ? {} : {
			previousManifestId: identifier(record.previousManifestId, "previous provider request"),
		}),
		...(boundary === undefined ? {} : { boundary }),
		...(record.schemaVersion === 2 ? {
			timelineWindowId: identifier(record.timelineWindowId, "provider request timeline window"),
			timelineEventIds: stringArray(record.timelineEventIds, "provider request timeline events"),
			requestConfigurationSha256: sha256(
				record.requestConfigurationSha256,
				"provider request configuration",
			),
			bootstrapPrefixSha256: sha256(record.bootstrapPrefixSha256, "provider bootstrap prefix"),
			timelineSha256: sha256(record.timelineSha256, "provider input timeline"),
			commonPrefixItemCount: nonNegativeInteger(
				record.commonPrefixItemCount,
				"provider request common prefix item count",
			),
		} : {}),
		...(record.schemaVersion === 3 ? {
			timelineWindowId: identifier(record.timelineWindowId, "provider request timeline window"),
			timelineEventCount: positiveInteger(
				record.timelineEventCount,
				"provider request timeline event count",
			),
			timelinePrefixSha256: sha256(record.timelinePrefixSha256, "provider timeline prefix"),
			requestConfigurationSha256: sha256(
				record.requestConfigurationSha256,
				"provider request configuration",
			),
			bootstrapPrefixSha256: sha256(record.bootstrapPrefixSha256, "provider bootstrap prefix"),
			timelineSha256: sha256(record.timelineSha256, "provider input timeline"),
			commonPrefixItemCount: nonNegativeInteger(
				record.commonPrefixItemCount,
				"provider request common prefix item count",
			),
		} : {}),
		createdAt: timestamp(record.createdAt, "provider request manifest"),
	};
	return Object.freeze(normalized) as ProviderRequestManifest;
}

export function validateManifestLogicalDigest(
	manifest: ProviderRequestManifest,
	instructions: InstructionSnapshot,
	tools: ToolSetSnapshot,
): void {
	const expected = manifest.schemaVersion === 3
		? manifestTimelineLogicalInputSha256(instructions, tools, manifest.timelineSha256)
		: manifestLogicalInputSha256(instructions, tools, manifest.orderedItems);
	if (manifest.logicalInputSha256 !== expected) {
		throw invalid("provider request logical input hash does not match");
	}
}

export function normalizeProviderRequest(value: ProviderRequest): ProviderRequest {
	const record = normalizedRecord(value, "logical provider request", MODEL_INPUT_JSON_MAX_CHARS);
	assertKeys(record, [
		"provider", "protocol", "model", "reasoningEffort", "maxOutputTokens", "sessionId", "cacheRetention",
		"store", "promptCacheKey", "cacheControlEnabled", "webSearchMode", "instructions", "developerInstructions", "messages", "items", "tools",
		"previousResponseId",
	], ["provider", "protocol", "model", "instructions", "messages", "tools"], "logical provider request");
	const config = normalizeProviderConfig(record, true);
	if (!Array.isArray(record.messages)) throw invalid("provider request messages are invalid");
	if (!Array.isArray(record.tools)) throw invalid("provider request tools are invalid");
	const messages = Object.freeze(record.messages.map(normalizeCanonicalMessage));
	const tools = Object.freeze(record.tools.map(normalizeToolDefinition));
	const items = record.items === undefined ? undefined : canonicalItems(record.items);
	if (items && stableJson(messages) !== stableJson(messagesFromItems(items))) {
		throw invalid("provider request messages do not match canonical items");
	}
	const developerInstructions = record.developerInstructions === undefined
		? undefined
		: stringArray(record.developerInstructions, "provider developer instructions");
	return Object.freeze({
		...config,
		instructions: boundedString(
			record.instructions,
			"provider instructions",
			INSTRUCTION_CONTENT_MAX_CHARS,
			true,
		),
		...(developerInstructions && developerInstructions.length > 0
			? { developerInstructions }
			: {}),
		messages,
		...(items ? { items } : {}),
		tools,
		...(record.previousResponseId === undefined ? {} : {
			previousResponseId: boundedString(record.previousResponseId, "previous response id", TEXT_FIELD_MAX_CHARS, true),
		}),
	});
}

export function normalizeLifecycleEvent(
	value: ProviderStepLifecycleEvent,
): ProviderStepLifecycleEvent {
	const record = normalizedRecord(value, "provider-step lifecycle event");
	assertKeys(record, ["eventId", "requestId", "sessionId", "state", "payload", "createdAt"], [
		"eventId", "requestId", "sessionId", "state", "payload", "createdAt",
	], "provider-step lifecycle event");
	const state = record.state;
	if (state !== "prepared" && state !== "dispatch_started" && state !== "acknowledged"
		&& state !== "failed" && state !== "unknown") {
		throw invalid("provider-step lifecycle state is invalid");
	}
	const payload = normalizedRecord(record.payload, "provider-step lifecycle payload", LIFECYCLE_PAYLOAD_MAX_CHARS);
	for (const [key, item] of Object.entries(payload)) {
		identifier(key, "provider-step lifecycle payload key");
		if (item !== null && typeof item !== "string" && typeof item !== "number"
			&& typeof item !== "boolean") {
			throw invalid("provider-step lifecycle payload is invalid");
		}
		if (typeof item === "number" && !Number.isFinite(item)) {
			throw invalid("provider-step lifecycle payload is invalid");
		}
		if (typeof item === "string" && item.length > TEXT_FIELD_MAX_CHARS) {
			throw invalid("provider-step lifecycle payload is invalid");
		}
	}
	return Object.freeze({
		eventId: identifier(record.eventId, "provider-step lifecycle event"),
		requestId: identifier(record.requestId, "provider request"),
		sessionId: identifier(record.sessionId, "provider-step session"),
		state,
		payload: Object.freeze(payload as ProviderStepLifecyclePayload),
		createdAt: timestamp(record.createdAt, "provider-step lifecycle event"),
	});
}

export function assertRequestMatchesSnapshots(
	request: ProviderRequest,
	manifest: ProviderRequestManifest,
	instructions: InstructionSnapshot,
	toolSet: ToolSetSnapshot,
): void {
	if (request.instructions !== instructions.content) {
		throw invalid("provider request instructions do not match their snapshot");
	}
	if (stableJson(request.tools) !== stableJson(toolSet.tools)) {
		throw invalid("provider request tools do not match their snapshot");
	}
	if (stableJson(providerConfigFromRequest(request)) !== stableJson(manifest.providerConfig)) {
		throw invalid("provider request configuration does not match its manifest");
	}
	if (manifest.schemaVersion === 3) {
		if (manifest.instructionSnapshotId !== instructions.snapshotId
			|| manifest.toolSetSnapshotId !== toolSet.snapshotId) {
			throw invalid("provider request snapshot identity does not match its manifest");
		}
		return;
	}
	const instructionReferences = manifest.orderedItems.filter((item) => (
		item.kind === "instruction_snapshot"
	));
	const toolReferences = manifest.orderedItems.filter((item) => item.kind === "tool_set_snapshot");
	if (instructionReferences.length !== 1
		|| instructionReferences[0]?.id !== instructions.snapshotId
		|| instructionReferences[0]?.role !== "system"
		|| instructionReferences[0]?.contentSha256 !== instructions.contentSha256) {
		throw invalid("provider request instruction reference is invalid");
	}
	if (toolReferences.length !== 1
		|| toolReferences[0]?.id !== toolSet.snapshotId
		|| toolReferences[0]?.contentSha256 !== toolSet.contentSha256) {
		throw invalid("provider request tool-set reference is invalid");
	}
}

export function modelInputBlob(value: unknown): { readonly id: string; readonly json: string } {
	let json: string;
	try {
		json = stableJson(value);
	} catch {
		throw invalid("model-input payload is not serializable");
	}
	if (!json || json.length > MODEL_INPUT_JSON_MAX_CHARS) {
		throw invalid("model-input payload is too large");
	}
	return Object.freeze({ id: modelInputSha256(value), json });
}

function normalizeInstructionFragment(value: unknown): InstructionFragment {
	const record = normalizedRecord(value, "instruction fragment");
	assertKeys(record, [
		"fragmentId", "key", "kind", "title", "content", "contentSha256", "role", "source",
		"cacheClass", "durability", "scope", "includeInMemory", "required", "metadata",
	], [
		"fragmentId", "key", "kind", "title", "content", "contentSha256", "role", "source",
		"cacheClass", "durability", "scope", "includeInMemory", "required",
	], "instruction fragment");
	if (!FRAGMENT_KINDS.has(String(record.kind))) throw invalid("instruction fragment kind is invalid");
	if (record.role !== "developer" && record.role !== "user") {
		throw invalid("instruction fragment role is invalid");
	}
	if (record.cacheClass !== "static" && record.cacheClass !== "dynamic"
		&& record.cacheClass !== "ephemeral") {
		throw invalid("instruction fragment cache class is invalid");
	}
	if (record.durability !== "persistent") {
		throw invalid("model-visible instruction fragment is not durable");
	}
	if (record.scope !== "session" && record.scope !== "turn" && record.scope !== "transcript") {
		throw invalid("instruction fragment scope is invalid");
	}
	if (typeof record.includeInMemory !== "boolean" || typeof record.required !== "boolean") {
		throw invalid("instruction fragment flags are invalid");
	}
	const content = boundedString(record.content, "instruction fragment content", CONTEXT_CONTENT_MAX_CHARS);
	const fragment: InstructionFragment = {
		fragmentId: identifier(record.fragmentId, "instruction fragment"),
		key: identifier(record.key, "instruction fragment key"),
		kind: record.kind as InstructionFragment["kind"],
		title: boundedString(record.title, "instruction fragment title", TEXT_FIELD_MAX_CHARS, true),
		content,
		contentSha256: sha256(record.contentSha256, "instruction fragment content"),
		role: record.role,
		source: boundedString(record.source, "instruction fragment source", TEXT_FIELD_MAX_CHARS, true),
		cacheClass: record.cacheClass,
		durability: "persistent",
		scope: record.scope,
		includeInMemory: record.includeInMemory,
		required: record.required,
		...(record.metadata === undefined ? {} : {
			metadata: Object.freeze(normalizedRecord(record.metadata, "instruction fragment metadata")),
		}),
	};
	if (fragment.contentSha256 !== modelInputSha256(content)) {
		throw invalid("instruction fragment content hash does not match");
	}
	return Object.freeze(fragment);
}

function normalizeModelInputReference(value: unknown): ModelInputReference {
	const record = normalizedRecord(value, "model-input reference");
	assertKeys(record, ["kind", "id", "role", "contentSha256"], [
		"kind", "id", "contentSha256",
	], "model-input reference");
	if (!REFERENCE_KINDS.has(String(record.kind))) throw invalid("model-input reference kind is invalid");
	if (record.role !== undefined && record.role !== "system"
		&& record.role !== "developer" && record.role !== "user") {
		throw invalid("model-input reference role is invalid");
	}
	return Object.freeze({
		kind: record.kind as ModelInputReference["kind"],
		id: identifier(record.id, "model-input reference"),
		...(record.role === undefined ? {} : { role: record.role }),
		contentSha256: sha256(record.contentSha256, "model-input reference content"),
	});
}

function normalizeProviderConfig(value: unknown, allowRequestFields = false): ProviderRequestConfig {
	const record = normalizedRecord(value, "provider request configuration");
	if (!allowRequestFields) {
		for (const key of Object.keys(record)) {
			if (!["provider", "protocol", "model", "reasoningEffort", "maxOutputTokens", "sessionId", "cacheRetention", "store", "promptCacheKey", "cacheControlEnabled", "webSearchMode"].includes(key)) {
				throw invalid("provider request configuration contains unknown fields");
			}
		}
	}
	if (!isProviderRouteId(record.provider) || !PROTOCOLS.has(String(record.protocol))) {
		throw invalid("provider request route is invalid");
	}
	if (record.reasoningEffort !== undefined && !REASONING_EFFORTS.has(String(record.reasoningEffort))) {
		throw invalid("provider reasoning effort is invalid");
	}
	if (record.cacheControlEnabled !== undefined && typeof record.cacheControlEnabled !== "boolean") {
		throw invalid("provider cache-control setting is invalid");
	}
	if (record.cacheRetention !== undefined
		&& record.cacheRetention !== "none"
		&& record.cacheRetention !== "short"
		&& record.cacheRetention !== "long") {
		throw invalid("provider cache retention is invalid");
	}
	if (record.webSearchMode !== undefined
		&& record.webSearchMode !== "live"
		&& record.webSearchMode !== "disabled") {
		throw invalid("provider web-search mode is invalid");
	}
	if (record.store !== undefined && typeof record.store !== "boolean") {
		throw invalid("provider storage setting is invalid");
	}
	const sessionId = record.sessionId === undefined
		? record.promptCacheKey === undefined
			? undefined
			: boundedString(record.promptCacheKey, "provider prompt cache key", TEXT_FIELD_MAX_CHARS, true)
		: boundedString(record.sessionId, "provider cache session", TEXT_FIELD_MAX_CHARS, true);
	const cacheRetention = record.cacheRetention
		?? (record.cacheControlEnabled === false
			? "none"
			: record.promptCacheKey !== undefined || record.cacheControlEnabled === true
				? "short"
				: undefined);
	return Object.freeze({
		provider: record.provider as ProviderRequestConfig["provider"],
		protocol: record.protocol as ProviderRequestConfig["protocol"],
		model: boundedString(record.model, "provider model", TEXT_FIELD_MAX_CHARS, true),
		...(record.reasoningEffort === undefined ? {} : {
			reasoningEffort: record.reasoningEffort as ProviderRequestConfig["reasoningEffort"],
		}),
		...(record.maxOutputTokens === undefined ? {} : {
			maxOutputTokens: positiveInteger(record.maxOutputTokens, "provider max output tokens"),
		}),
		...(sessionId === undefined ? {} : { sessionId }),
		...(cacheRetention === undefined ? {} : { cacheRetention }),
		...(record.webSearchMode === undefined ? {} : {
			webSearchMode: record.webSearchMode,
		}),
	});
}

function providerConfigFromRequest(request: ProviderRequest): ProviderRequestConfig {
	return Object.freeze({
		provider: request.provider,
		protocol: request.protocol,
		model: request.model,
		...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
		...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
		...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
		...(request.cacheRetention === undefined ? {} : { cacheRetention: request.cacheRetention }),
		...(request.webSearchMode === undefined ? {} : {
			webSearchMode: request.webSearchMode,
		}),
	});
}

function normalizeToolDefinition(value: unknown): ToolDefinition {
	const record = normalizedRecord(value, "tool definition");
	assertKeys(record, ["id", "name", "description", "inputSchema"], [
		"id", "name", "description", "inputSchema",
	], "tool definition");
	return Object.freeze({
		id: identifier(record.id, "tool definition"),
		name: identifier(record.name, "tool name"),
		description: boundedString(record.description, "tool description", TOOL_DESCRIPTION_MAX_CHARS),
		inputSchema: Object.freeze(normalizedRecord(record.inputSchema, "tool input schema")),
	});
}

function normalizeCanonicalMessage(value: unknown): { readonly role: "user" | "assistant"; readonly content: string } {
	const record = normalizedRecord(value, "provider message");
	assertKeys(record, ["role", "content"], ["role", "content"], "provider message");
	if (record.role !== "user" && record.role !== "assistant") {
		throw invalid("provider message role is invalid");
	}
	return Object.freeze({
		role: record.role,
		content: boundedString(record.content, "provider message content", CONTEXT_CONTENT_MAX_CHARS),
	});
}

function canonicalItems(value: unknown): readonly CanonicalConversationItem[] {
	if (!Array.isArray(value)) throw invalid("provider request canonical items are invalid");
	return Object.freeze(value.map(normalizeCanonicalItem));
}

function normalizeCanonicalItem(value: unknown): CanonicalConversationItem {
	const record = normalizedRecord(value, "canonical provider item");
	if (record.type === "user") {
		assertKeys(record, ["type", "text", "images"], ["type", "text"], "canonical user item");
		const images = record.images === undefined ? undefined : canonicalImages(record.images);
		return Object.freeze({
			type: "user",
			text: boundedString(record.text, "canonical user text", CONTEXT_CONTENT_MAX_CHARS),
			...(images && images.length > 0 ? { images } : {}),
		});
	}
	if (record.type === "assistant") {
		assertKeys(record, ["type", "text", "providerState"], ["type", "text"], "canonical assistant item");
		return Object.freeze({
			type: "assistant",
			text: boundedString(record.text, "canonical assistant text", CONTEXT_CONTENT_MAX_CHARS),
			...(record.providerState === undefined ? {} : {
				providerState: normalizeProviderReplayState(record.providerState),
			}),
		});
	}
	if (record.type === "assistant_tool_calls") {
		assertKeys(record, ["type", "text", "calls", "responseId", "providerState"], [
			"type", "text", "calls",
		], "canonical tool-call item");
		if (!Array.isArray(record.calls) || record.calls.length === 0) {
			throw invalid("canonical tool calls are invalid");
		}
		return Object.freeze({
			type: "assistant_tool_calls",
			text: boundedString(record.text, "canonical tool-call text", CONTEXT_CONTENT_MAX_CHARS),
			calls: Object.freeze(record.calls.map(normalizeCanonicalToolCall)),
			...(record.responseId === undefined ? {} : {
				responseId: boundedString(record.responseId, "provider response id", TEXT_FIELD_MAX_CHARS, true),
			}),
			...(record.providerState === undefined ? {} : {
				providerState: normalizeProviderReplayState(record.providerState),
			}),
		});
	}
	if (record.type === "context") {
		assertKeys(record, ["type", "text", "metadata"], ["type", "text", "metadata"], "canonical context item");
		return Object.freeze({
			type: "context",
			text: boundedString(record.text, "canonical context text", CONTEXT_CONTENT_MAX_CHARS),
			metadata: normalizeContextMetadata(record.metadata),
		});
	}
	if (record.type === "tool_result") {
		assertKeys(record, ["type", "callId", "toolName", "output", "success"], [
			"type", "callId", "toolName", "output", "success",
		], "canonical tool-result item");
		if (typeof record.success !== "boolean") throw invalid("canonical tool result is invalid");
		return Object.freeze({
			type: "tool_result",
			callId: identifier(record.callId, "canonical tool call"),
			toolName: identifier(record.toolName, "canonical tool name"),
			output: boundedString(record.output, "canonical tool output", CONTEXT_CONTENT_MAX_CHARS),
			success: record.success,
		});
	}
	throw invalid("canonical provider item type is invalid");
}

function normalizeCanonicalToolCall(value: unknown): {
	readonly callId: string;
	readonly name: string;
	readonly argumentsJson: string;
} {
	const record = normalizedRecord(value, "canonical tool call");
	assertKeys(record, ["callId", "name", "argumentsJson"], [
		"callId", "name", "argumentsJson",
	], "canonical tool call");
	const argumentsJson = boundedString(record.argumentsJson, "canonical tool arguments", CONTEXT_CONTENT_MAX_CHARS, true);
	try {
		const parsed = JSON.parse(argumentsJson) as unknown;
		if (!isRecord(parsed)) throw new Error("not an object");
	} catch {
		throw invalid("canonical tool arguments are invalid");
	}
	return Object.freeze({
		callId: identifier(record.callId, "canonical tool call"),
		name: identifier(record.name, "canonical tool name"),
		argumentsJson,
	});
}

function normalizeProviderReplayState(value: unknown): ProviderReplayState {
	const record = normalizedRecord(value, "provider replay state");
	assertKeys(
		record,
		["provider", "value", "tokenEstimate"],
		["provider", "value"],
		"provider replay state",
	);
	if (!isProviderRouteId(record.provider)) throw invalid("provider replay state route is invalid");
	return Object.freeze({
		provider: record.provider as ProviderReplayState["provider"],
		value: Object.freeze(normalizedRecord(record.value, "provider replay value")),
		...(record.tokenEstimate === undefined ? {} : {
			tokenEstimate: nonNegativeInteger(record.tokenEstimate, "provider replay token estimate"),
		}),
	});
}

function normalizeContextMetadata(value: unknown): CanonicalContextMetadata {
	const record = normalizedRecord(value, "canonical context metadata");
	assertKeys(record, [
		"kind", "role", "cacheClass", "durability", "scope", "sourceId", "contentSha256",
		"contentLength", "supersedesItemId", "tombstone",
	], [
		"kind", "cacheClass", "durability", "scope", "sourceId", "contentSha256", "contentLength",
	], "canonical context metadata");
	if (!CONTEXT_KINDS.has(String(record.kind))) throw invalid("canonical context kind is invalid");
	if (record.role !== undefined && record.role !== "developer" && record.role !== "user") {
		throw invalid("canonical context role is invalid");
	}
	if (record.cacheClass !== "static" && record.cacheClass !== "dynamic"
		&& record.cacheClass !== "ephemeral") throw invalid("canonical context cache class is invalid");
	if (record.durability !== "persistent") throw invalid("canonical context is not durable");
	if (record.scope !== "session" && record.scope !== "turn" && record.scope !== "transcript") {
		throw invalid("canonical context scope is invalid");
	}
	if (record.tombstone !== undefined && typeof record.tombstone !== "boolean") {
		throw invalid("canonical context tombstone is invalid");
	}
	return Object.freeze({
		kind: record.kind as CanonicalContextMetadata["kind"],
		...(record.role === undefined ? {} : { role: record.role }),
		cacheClass: record.cacheClass,
		durability: "persistent",
		scope: record.scope,
		sourceId: identifier(record.sourceId, "canonical context source"),
		contentSha256: sha256(record.contentSha256, "canonical context content"),
		contentLength: nonNegativeInteger(record.contentLength, "canonical context content length"),
		...(record.supersedesItemId === undefined ? {} : {
			supersedesItemId: identifier(record.supersedesItemId, "superseded canonical context item"),
		}),
		...(record.tombstone === undefined ? {} : { tombstone: record.tombstone }),
	});
}

function canonicalImages(value: unknown): readonly {
	readonly mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	readonly data: string;
}[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
		throw invalid("canonical provider images are invalid");
	}
	return Object.freeze(value.map((image) => {
		const record = normalizedRecord(image, "canonical provider image");
		assertKeys(record, ["mediaType", "data"], ["mediaType", "data"], "canonical provider image");
		if (record.mediaType !== "image/jpeg" && record.mediaType !== "image/png"
			&& record.mediaType !== "image/gif" && record.mediaType !== "image/webp") {
			throw invalid("canonical provider image media type is invalid");
		}
		const data = boundedString(record.data, "canonical provider image data", 24 * 1024 * 1024, true);
		if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
			throw invalid("canonical provider image data is invalid");
		}
		return Object.freeze({ mediaType: record.mediaType, data });
	}));
}

function messagesFromItems(items: readonly CanonicalConversationItem[]): readonly {
	readonly role: "user" | "assistant";
	readonly content: string;
}[] {
	return items.flatMap((item): Array<{
		readonly role: "user" | "assistant";
		readonly content: string;
	}> => {
		if (item.type === "user") return [{ role: "user" as const, content: item.text }];
		if (item.type === "assistant") return [{ role: "assistant" as const, content: item.text }];
		if (item.type === "assistant_tool_calls" && item.text) {
			return [{ role: "assistant" as const, content: item.text }];
		}
		return [];
	});
}

function normalizedRecord(value: unknown, label: string, maxChars = MODEL_INPUT_JSON_MAX_CHARS): Record<string, unknown> {
	let json: string;
	try {
		json = stableJson(value);
	} catch {
		throw invalid(`${label} is not serializable`);
	}
	if (!json || json.length > maxChars) throw invalid(`${label} is too large`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(json) as unknown;
	} catch {
		throw invalid(`${label} is invalid`);
	}
	if (!isRecord(parsed)) throw invalid(`${label} is invalid`);
	return parsed;
}

function stringArray(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value)) throw invalid(`${label} are invalid`);
	return Object.freeze(value.map((item) => boundedString(
		item,
		label,
		CONTEXT_CONTENT_MAX_CHARS,
		true,
	)));
}

function assertKeys(
	record: Readonly<Record<string, unknown>>,
	allowed: readonly string[],
	required: readonly string[],
	label: string,
): void {
	const allowedSet = new Set(allowed);
	if (Object.keys(record).some((key) => !allowedSet.has(key))) {
		throw invalid(`${label} contains unknown fields`);
	}
	if (required.some((key) => !(key in record))) throw invalid(`${label} is incomplete`);
}

function identifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
		throw invalid(`${label} id is invalid`);
	}
	return value;
}

function sha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw invalid(`${label} hash is invalid`);
	}
	return value;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 64
		|| !Number.isFinite(Date.parse(value))) {
		throw invalid(`${label} timestamp is invalid`);
	}
	return value;
}

function boundedString(
	value: unknown,
	label: string,
	maxChars: number,
	required = false,
): string {
	if (typeof value !== "string" || value.length > maxChars || (required && value.length === 0)
		|| value.includes("\0")) {
		throw invalid(`${label} is invalid`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw invalid(`${label} is invalid`);
	}
	return value;
}

function positiveInteger(value: unknown, label: string): number {
	const result = nonNegativeInteger(value, label);
	if (result === 0) throw invalid(`${label} is invalid`);
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): StorageFailure {
	return new StorageFailure(message);
}

import { createHash } from "node:crypto";
import type {
	CanonicalConversationItem,
	ProviderRequestConfig,
	ToolDefinition,
} from "./types.ts";

export type ModelInputRole = "system" | "developer" | "user";
export type ModelInputCacheClass = "static" | "dynamic" | "ephemeral";
export type ModelInputDurability = "persistent" | "api_only";
export type ModelInputScope = "session" | "turn" | "transcript";

export type InstructionFragmentKind =
	| "collaboration_mode"
	| "permissions"
	| "tool_exposure"
	| "skill_catalog"
	| "skill_instructions"
	| "workspace_instructions"
	| "environment_context"
	| "conversation_context"
	| "compaction_rehydration"
	| "memory"
	| "plan"
	| "hook_context"
	| "runtime_policy_reminder"
	| "runtime_context_reminder"
	| "subagent_context";

export interface InstructionSnapshot {
	readonly snapshotId: string;
	readonly version: string;
	readonly source: string;
	readonly content: string;
	readonly contentSha256: string;
	readonly createdAt: string;
}

export interface ToolSetSnapshot {
	readonly snapshotId: string;
	readonly tools: readonly ToolDefinition[];
	readonly contentSha256: string;
	readonly createdAt: string;
}

export interface TurnContextSection {
	readonly key: string;
	readonly kind: InstructionFragmentKind;
	readonly title: string;
	readonly content: string;
	readonly role: Exclude<ModelInputRole, "system">;
	readonly source: string;
	readonly cacheClass: ModelInputCacheClass;
	readonly durability: ModelInputDurability;
	readonly scope: ModelInputScope;
	readonly includeInMemory: boolean;
	readonly required: boolean;
	readonly enabled: boolean;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InstructionFragment extends Omit<TurnContextSection, "enabled"> {
	readonly fragmentId: string;
	readonly contentSha256: string;
}

export interface InstructionContract {
	readonly baseInstructions: InstructionSnapshot;
	readonly developerSections: readonly InstructionFragment[];
	readonly contextualUserSections: readonly InstructionFragment[];
	readonly conversationItems: readonly CanonicalConversationItem[];
	readonly currentUserRequest: string;
}

export interface ModelContextEvent {
	readonly eventId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly providerStep: number;
	readonly sectionKey: string;
	readonly fragment?: InstructionFragment;
	readonly supersedesEventId?: string;
	readonly tombstone: boolean;
	readonly createdAt: string;
}

export type ProviderInputWindowBoundary =
	| "bootstrap"
	| "legacy_bootstrap"
	| "compaction"
	| "source_reset";

export type ProviderInputTimelineEventKind =
	| "window_boundary"
	| "conversation_item"
	| "context_update"
	| "context_tombstone";

export interface ProviderInputTimelineEvent {
	readonly eventId: string;
	readonly sessionId: string;
	readonly windowId: string;
	readonly turnId: string;
	readonly providerStep: number;
	readonly kind: ProviderInputTimelineEventKind;
	readonly item?: CanonicalConversationItem;
	readonly sourceIndex?: number;
	readonly modelContextEventId?: string;
	readonly boundary?: ProviderInputWindowBoundary;
	readonly contentSha256: string;
	readonly createdAt: string;
}

export type ModelInputReferenceKind =
	| "instruction_snapshot"
	| "tool_set_snapshot"
	| "context_event"
	| "conversation_item"
	| "provider_native_item"
	| "provider_timeline_event"
	| "compaction_boundary";

export interface ModelInputReference {
	readonly kind: ModelInputReferenceKind;
	readonly id: string;
	readonly role?: ModelInputRole;
	readonly contentSha256: string;
}

export type ProviderRequestBoundary =
	| ProviderInputWindowBoundary
	| "continuation_reset";

interface ProviderRequestManifestBase {
	readonly requestId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly providerStep: number;
	readonly providerConfig: ProviderRequestConfig;
	readonly instructionSnapshotId: string;
	readonly toolSetSnapshotId: string;
	readonly requestSignature: string;
	readonly logicalInputSha256: string;
	readonly contextPrefixSha256: string;
	readonly previousManifestId?: string;
	readonly boundary?: ProviderRequestBoundary;
	readonly createdAt: string;
}

export interface ProviderRequestManifestV1 extends ProviderRequestManifestBase {
	readonly schemaVersion: 1;
	readonly orderedItems: readonly ModelInputReference[];
}

export interface ProviderRequestManifestV2 extends ProviderRequestManifestBase {
	readonly schemaVersion: 2;
	readonly orderedItems: readonly ModelInputReference[];
	readonly timelineWindowId: string;
	readonly timelineEventIds: readonly string[];
	readonly requestConfigurationSha256: string;
	readonly bootstrapPrefixSha256: string;
	readonly timelineSha256: string;
	readonly commonPrefixItemCount: number;
}

export interface ProviderRequestManifestV3 extends ProviderRequestManifestBase {
	readonly schemaVersion: 3;
	readonly timelineWindowId: string;
	readonly timelineEventCount: number;
	readonly timelinePrefixSha256: string;
	readonly requestConfigurationSha256: string;
	readonly bootstrapPrefixSha256: string;
	readonly timelineSha256: string;
	readonly commonPrefixItemCount: number;
}

export type ProviderRequestManifest =
	| ProviderRequestManifestV1
	| ProviderRequestManifestV2
	| ProviderRequestManifestV3;

const CACHE_ORDER: Readonly<Record<ModelInputCacheClass, number>> = Object.freeze({
	static: 0,
	dynamic: 1,
	ephemeral: 2,
});

const KIND_ORDER: Readonly<Record<InstructionFragmentKind, number>> = Object.freeze({
	collaboration_mode: 0,
	permissions: 1,
	tool_exposure: 2,
	skill_catalog: 3,
	skill_instructions: 4,
	workspace_instructions: 10,
	environment_context: 11,
	conversation_context: 12,
	compaction_rehydration: 13,
	memory: 14,
	plan: 15,
	hook_context: 20,
	runtime_policy_reminder: 21,
	runtime_context_reminder: 22,
	subagent_context: 23,
});

export function modelInputSha256(value: unknown): string {
	const content = typeof value === "string" ? value : stableModelInputJson(value);
	return createHash("sha256").update(content).digest("hex");
}

export function stableModelInputJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

export function orderInstructionFragments(
	fragments: readonly InstructionFragment[],
): readonly InstructionFragment[] {
	return Object.freeze([...fragments].sort((left, right) => (
		CACHE_ORDER[left.cacheClass] - CACHE_ORDER[right.cacheClass]
		|| KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
		|| compareText(left.key, right.key)
		|| compareText(left.fragmentId, right.fragmentId)
	)));
}

export function effectiveModelContextEvents(
	events: readonly ModelContextEvent[],
): ReadonlyMap<string, ModelContextEvent> {
	const byId = new Map<string, ModelContextEvent>();
	const effective = new Map<string, ModelContextEvent>();
	for (const event of events) {
		if (byId.has(event.eventId)) throw new TypeError("duplicate model context event id");
		const previous = effective.get(event.sectionKey);
		if (event.supersedesEventId !== undefined) {
			if (!previous || previous.eventId !== event.supersedesEventId) {
				throw new TypeError("model context supersession does not target the effective event");
			}
		} else if (previous) {
			throw new TypeError("model context update must supersede the effective event");
		}
		if (event.tombstone && event.fragment !== undefined) {
			throw new TypeError("model context tombstone must not contain a fragment");
		}
		if (!event.tombstone && event.fragment === undefined) {
			throw new TypeError("model context event is missing its fragment");
		}
		byId.set(event.eventId, event);
		if (event.tombstone) effective.delete(event.sectionKey);
		else effective.set(event.sectionKey, event);
	}
	return new Map(effective);
}

export function manifestLogicalInputSha256(
	instructionSnapshot: InstructionSnapshot,
	toolSetSnapshot: ToolSetSnapshot,
	orderedItems: readonly ModelInputReference[],
): string {
	return modelInputSha256({
		instruction_snapshot: instructionSnapshot.contentSha256,
		tool_set_snapshot: toolSetSnapshot.contentSha256,
		ordered_items: orderedItems,
	});
}

export function manifestTimelineLogicalInputSha256(
	instructionSnapshot: InstructionSnapshot,
	toolSetSnapshot: ToolSetSnapshot,
	timelineSha256: string,
): string {
	return modelInputSha256({
		instruction_snapshot: instructionSnapshot.contentSha256,
		tool_set_snapshot: toolSetSnapshot.contentSha256,
		timeline: timelineSha256,
	});
}

export function providerTimelinePrefixSha256(
	events: readonly ProviderInputTimelineEvent[],
): string {
	return modelInputSha256(events.map((event) => ({
		event_id: event.eventId,
		window_id: event.windowId,
		kind: event.kind,
		content_sha256: event.contentSha256,
	})));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => compareText(left, right))
			.map(([key, item]) => [key, sortJson(item)]),
	);
}

function compareText(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

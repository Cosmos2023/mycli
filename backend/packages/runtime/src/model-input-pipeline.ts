import { randomUUID } from "node:crypto";
import {
	effectiveModelContextEvents,
	manifestTimelineLogicalInputSha256,
	modelInputSha256,
	orderProviderConversationItems,
	projectProviderRequest,
	providerTimelinePrefixSha256,
	stableModelInputJson,
} from "@mycli/core";
import type {
	CanonicalConversationItem,
	InstructionFragment,
	InstructionSnapshot,
	ModelContextEvent,
	ProviderRequest,
	ProviderRequestConfig,
	ProviderRequestManifestV3,
	ToolDefinition,
	ToolSetSnapshot,
} from "@mycli/core";
import type {
	CommittedProviderStep,
	ModelInputLedgerStore,
} from "@mycli/storage";
import {
	budgetInstructionContract,
} from "./instruction-budget.ts";
import type { InstructionBudgetDiagnostic } from "./instruction-budget.ts";
import {
	collectTurnContext,
	InstructionContractAssembler,
} from "./instruction-context.ts";
import type { TurnContextSources } from "./instruction-context.ts";
import {
	buildProviderRequestSignature,
} from "./provider-continuation.ts";
import {
	commonPrefixItemCount,
	projectProviderInputTimeline,
} from "./provider-input-timeline.ts";
import type { TokenCounter } from "./token-counter.ts";

export interface CommitRuntimeProviderStepInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly providerStep: number;
	readonly requestConfig: ProviderRequestConfig;
	readonly instructionSnapshot: InstructionSnapshot;
	readonly tools: readonly ToolDefinition[];
	readonly history: readonly CanonicalConversationItem[];
	readonly currentUserRequest: string;
	readonly sources: TurnContextSources;
	readonly ledger: ModelInputLedgerStore;
	readonly maxPromptTokens: number;
	readonly clock: () => string;
	readonly createId?: (kind: "tools" | "context" | "request" | "lifecycle") => string;
	readonly tokenCounter?: TokenCounter;
}

export interface CommittedRuntimeProviderStep extends CommittedProviderStep {
	readonly manifest: ProviderRequestManifestV3;
	readonly requestSignature: string;
	readonly contextPrefixSha256: string;
	readonly budget: InstructionBudgetDiagnostic;
}

export function commitRuntimeProviderStep(
	input: CommitRuntimeProviderStepInput,
): CommittedRuntimeProviderStep {
	if (!Number.isSafeInteger(input.providerStep) || input.providerStep < 1) {
		throw new RangeError("provider step must be a positive safe integer");
	}
	const now = input.clock();
	const createId = input.createId ?? ((kind) => `${kind}-${randomUUID()}`);
	const tools = normalizedTools(input.tools);
	const toolSetSnapshot = resolveToolSetSnapshot(input, tools, now, createId);
	const split = splitCurrentInput(
		orderProviderConversationItems(input.history),
		input.currentUserRequest,
	);
	const turnContext = collectTurnContext({
		sources: { ...input.sources, tools },
		conversationItems: [...split.before, ...split.after],
		currentUserRequest: input.currentUserRequest,
	});
	const assembled = new InstructionContractAssembler().assemble({
		baseInstructions: input.instructionSnapshot,
		turnContext,
	});
	const budgeted = budgetInstructionContract({
		contract: assembled,
		tools,
		maxTokens: input.maxPromptTokens,
		...(input.tokenCounter ? { tokenCounter: input.tokenCounter } : {}),
	});
	const fragments = [
		...budgeted.contract.developerSections,
		...budgeted.contract.contextualUserSections,
	];
	const context = contextEvents({
		ledger: input.ledger,
		sessionId: input.sessionId,
		turnId: input.turnId,
		providerStep: input.providerStep,
		fragments,
		createdAt: now,
		createId,
	});
	const previous = input.ledger.loadLatestProviderRequestManifest(input.sessionId);
	const timeline = projectProviderInputTimeline({
		sessionId: input.sessionId,
		turnId: input.turnId,
		providerStep: input.providerStep,
		history: input.history,
		currentUserRequest: input.currentUserRequest,
		fragments,
		contextHistory: context.history,
		contextEvents: context.events,
		timelineHistory: input.ledger.loadProviderInputTimelineEvents(input.sessionId),
		...(previous ? { previousManifest: previous } : {}),
		createdAt: now,
	});
	const requestConfigurationSha256 = modelInputSha256({
		provider_config: input.requestConfig,
		instruction_snapshot_sha256: input.instructionSnapshot.contentSha256,
		tool_set_snapshot_sha256: toolSetSnapshot.contentSha256,
	});
	const requestSignature = buildProviderRequestSignature({
		...input.requestConfig,
		instructions: input.instructionSnapshot.content,
		tools,
		instructionSnapshotSha256: input.instructionSnapshot.contentSha256,
		toolSetSnapshotSha256: toolSetSnapshot.contentSha256,
	});
	const request = projectProviderRequest({
		config: input.requestConfig,
		instructions: input.instructionSnapshot.content,
		history: timeline.items,
		tools,
	});
	const previousRequest = previous
		? input.ledger.reconstructProviderStep(previous.requestId).request
		: undefined;
	const commonPrefix = (previous?.schemaVersion === 2 || previous?.schemaVersion === 3)
		&& previous.timelineWindowId === timeline.windowId
		&& previousRequest
		? commonPrefixItemCount(previousRequest.items ?? [], timeline.items)
		: 0;
	const bootstrapPrefixSha256 = modelInputSha256({
		instruction_snapshot_sha256: input.instructionSnapshot.contentSha256,
		tool_set_snapshot_sha256: toolSetSnapshot.contentSha256,
		items: timeline.bootstrapItems,
	});
	const timelineSha256 = modelInputSha256(timeline.items);
	const contextPrefixSha256 = bootstrapPrefixSha256;
	const boundary = timeline.boundary
		?? (previous && previous.requestSignature !== requestSignature
			? "continuation_reset" as const
			: undefined);
	const requestId = createId("request");
	const manifest: ProviderRequestManifestV3 = Object.freeze({
		schemaVersion: 3,
		requestId,
		sessionId: input.sessionId,
		turnId: input.turnId,
		providerStep: input.providerStep,
		providerConfig: input.requestConfig,
		instructionSnapshotId: input.instructionSnapshot.snapshotId,
		toolSetSnapshotId: toolSetSnapshot.snapshotId,
		requestSignature,
		logicalInputSha256: manifestTimelineLogicalInputSha256(
			input.instructionSnapshot,
			toolSetSnapshot,
			timelineSha256,
		),
		contextPrefixSha256,
		timelineWindowId: timeline.windowId,
		timelineEventCount: timeline.timelineEvents.length,
		timelinePrefixSha256: providerTimelinePrefixSha256(timeline.timelineEvents),
		requestConfigurationSha256,
		bootstrapPrefixSha256,
		timelineSha256,
		commonPrefixItemCount: commonPrefix,
		...(previous ? { previousManifestId: previous.requestId } : {}),
		...(boundary ? { boundary } : {}),
		createdAt: now,
	});
	const committed = input.ledger.commitProviderStep({
		instructionSnapshot: input.instructionSnapshot,
		toolSetSnapshot,
		contextEvents: context.events,
		timelineEvents: timeline.events,
		manifest,
		request,
		preparedEvent: Object.freeze({
			eventId: createId("lifecycle"),
			requestId,
			sessionId: input.sessionId,
			state: "prepared",
			payload: Object.freeze({ provider_step: input.providerStep }),
			createdAt: now,
		}),
	});
	return Object.freeze({
		...committed,
		manifest,
		requestSignature,
		contextPrefixSha256,
		budget: budgeted.diagnostic,
	});
}

function resolveToolSetSnapshot(
	input: CommitRuntimeProviderStepInput,
	tools: readonly ToolDefinition[],
	createdAt: string,
	createId: NonNullable<CommitRuntimeProviderStepInput["createId"]>,
): ToolSetSnapshot {
	const contentSha256 = modelInputSha256(tools);
	const latest = input.ledger.loadLatestToolSetSnapshot(input.sessionId);
	if (latest?.contentSha256 === contentSha256
		&& stableModelInputJson(latest.tools) === stableModelInputJson(tools)) {
		return latest;
	}
	return Object.freeze({
		snapshotId: createId("tools"),
		tools,
		contentSha256,
		createdAt,
	});
}

function contextEvents(input: {
	readonly ledger: ModelInputLedgerStore;
	readonly sessionId: string;
	readonly turnId: string;
	readonly providerStep: number;
	readonly fragments: readonly InstructionFragment[];
	readonly createdAt: string;
	readonly createId: NonNullable<CommitRuntimeProviderStepInput["createId"]>;
}): {
	readonly events: readonly ModelContextEvent[];
	readonly history: readonly ModelContextEvent[];
} {
	const history = input.ledger.loadModelContextEvents(input.sessionId);
	const current = effectiveModelContextEvents(history);
	const desired = new Map(input.fragments.map((fragment) => [fragment.key, fragment]));
	const events: ModelContextEvent[] = [];
	for (const fragment of input.fragments) {
		const previous = current.get(fragment.key);
		if (previous?.fragment
			&& stableModelInputJson(previous.fragment) === stableModelInputJson(fragment)) {
			continue;
		}
		events.push(Object.freeze({
			eventId: input.createId("context"),
			sessionId: input.sessionId,
			turnId: input.turnId,
			providerStep: input.providerStep,
			sectionKey: fragment.key,
			fragment,
			...(previous ? { supersedesEventId: previous.eventId } : {}),
			tombstone: false,
			createdAt: input.createdAt,
		}));
	}
	for (const [key, previous] of current) {
		if (desired.has(key)) continue;
		events.push(Object.freeze({
			eventId: input.createId("context"),
			sessionId: input.sessionId,
			turnId: input.turnId,
			providerStep: input.providerStep,
			sectionKey: key,
			supersedesEventId: previous.eventId,
			tombstone: true,
			createdAt: input.createdAt,
		}));
	}
	return Object.freeze({
		events: Object.freeze(events),
		history: Object.freeze([...history, ...events]),
	});
}

function splitCurrentInput(
	history: readonly CanonicalConversationItem[],
	currentUserRequest: string,
): {
	readonly before: readonly CanonicalConversationItem[];
	readonly current: Extract<CanonicalConversationItem, { readonly type: "user" }>;
	readonly after: readonly CanonicalConversationItem[];
} {
	let index = -1;
	for (let candidate = history.length - 1; candidate >= 0; candidate -= 1) {
		const item = history[candidate];
		if (item?.type === "user" && item.text === currentUserRequest) {
			index = candidate;
			break;
		}
	}
	if (index < 0) {
		return Object.freeze({
			before: Object.freeze([...history]),
			current: Object.freeze({ type: "user", text: currentUserRequest }),
			after: Object.freeze([]),
		});
	}
	return Object.freeze({
		before: Object.freeze(history.slice(0, index)),
		current: history[index] as Extract<CanonicalConversationItem, { readonly type: "user" }>,
		after: Object.freeze(history.slice(index + 1)),
	});
}

function normalizedTools(tools: readonly ToolDefinition[]): readonly ToolDefinition[] {
	return Object.freeze(tools.map((tool) => Object.freeze({
			...tool,
			inputSchema: deepFreeze(JSON.parse(stableModelInputJson(tool.inputSchema)) as Record<string, unknown>),
		})));
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

export type { ProviderRequest };

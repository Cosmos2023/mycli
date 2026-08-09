import {
	modelInputSha256,
	orderProviderConversationItems,
	stableModelInputJson,
} from "@mycli/core";
import type {
	CanonicalContextKind,
	CanonicalConversationItem,
	InstructionFragment,
	ModelContextEvent,
	ProviderInputTimelineEvent,
	ProviderInputWindowBoundary,
	ProviderRequestManifest,
} from "@mycli/core";

export interface ProjectProviderInputTimelineInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly providerStep: number;
	readonly history: readonly CanonicalConversationItem[];
	readonly currentUserRequest: string;
	readonly fragments: readonly InstructionFragment[];
	readonly contextHistory: readonly ModelContextEvent[];
	readonly contextEvents: readonly ModelContextEvent[];
	readonly timelineHistory: readonly ProviderInputTimelineEvent[];
	readonly previousManifest?: ProviderRequestManifest;
	readonly createdAt: string;
}

export interface ProviderInputTimelineProjection {
	readonly windowId: string;
	readonly boundary?: ProviderInputWindowBoundary;
	readonly events: readonly ProviderInputTimelineEvent[];
	readonly timelineEvents: readonly ProviderInputTimelineEvent[];
	readonly timelineEventIds: readonly string[];
	readonly items: readonly CanonicalConversationItem[];
	readonly bootstrapItems: readonly CanonicalConversationItem[];
}

export function projectProviderInputTimeline(
	input: ProjectProviderInputTimelineInput,
): ProviderInputTimelineProjection {
	const history = orderProviderConversationItems(input.history);
	const currentWindow = currentWindowEvents(input.timelineHistory);
	const priorConversation = currentWindow
		.filter((event) => event.kind === "conversation_item")
		.map(requiredItem);
	const sourceExtends = isExactPrefix(priorConversation, history);
	const boundary = windowBoundary(input, currentWindow, sourceExtends);
	const windowId = boundary
		? nextWindowId(input, boundary)
		: requiredWindowId(currentWindow);
	const boundaryEvent = boundary
		? [createBoundaryEvent(input, windowId, boundary)]
		: [];
	const contextEvents = boundary
		? input.fragments.map((fragment) => activeContextEvent(input.contextHistory, fragment))
		: input.contextEvents;
	const contextTimelineEvents = contextEvents.map((event) => createContextTimelineEvent({
		input,
		windowId,
		event,
		timelineHistory: input.timelineHistory,
	}));
	const conversationStart = boundary ? 0 : priorConversation.length;
	const unsynced = history.slice(conversationStart);
	const conversationEvents = unsynced.map((item, offset) => createConversationTimelineEvent({
		input,
		windowId,
		item,
		sourceIndex: conversationStart + offset,
	}));
	const appendedItems = boundary
		? [...contextTimelineEvents, ...conversationEvents]
		: insertContextBeforeCurrentUser({
			conversationEvents,
			contextEvents: contextTimelineEvents,
			conversationStart,
			history,
			currentUserRequest: input.currentUserRequest,
		});
	const events = Object.freeze([...boundaryEvent, ...appendedItems]);
	const timelineEvents = Object.freeze([
		...(boundary ? [] : currentWindow),
		...events,
	]);
	const items = Object.freeze(timelineEvents.flatMap((event) => (
		event.item ? [event.item] : []
	)));
	return Object.freeze({
		windowId,
		...(boundary ? { boundary } : {}),
		events,
		timelineEvents,
		timelineEventIds: Object.freeze(timelineEvents.map((event) => event.eventId)),
		items,
		bootstrapItems: staticBootstrapItems(timelineEvents),
	});
}

export function commonPrefixItemCount(
	left: readonly CanonicalConversationItem[],
	right: readonly CanonicalConversationItem[],
): number {
	const count = Math.min(left.length, right.length);
	let index = 0;
	while (index < count && stableModelInputJson(left[index]) === stableModelInputJson(right[index])) {
		index += 1;
	}
	return index;
}

function currentWindowEvents(
	events: readonly ProviderInputTimelineEvent[],
): readonly ProviderInputTimelineEvent[] {
	let boundaryIndex = -1;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (events[index]?.kind === "window_boundary") {
			boundaryIndex = index;
			break;
		}
	}
	return boundaryIndex < 0 ? Object.freeze([]) : Object.freeze(events.slice(boundaryIndex));
}

function windowBoundary(
	input: ProjectProviderInputTimelineInput,
	currentWindow: readonly ProviderInputTimelineEvent[],
	sourceExtends: boolean,
): ProviderInputWindowBoundary | undefined {
	if (currentWindow.length === 0) {
		return input.previousManifest ? "legacy_bootstrap" : "bootstrap";
	}
	if (sourceExtends) return undefined;
	const priorItems = currentWindow.flatMap((event) => event.item ? [event.item] : []);
	return introducesCompaction(input.history, priorItems) ? "compaction" : "source_reset";
}

function nextWindowId(
	input: ProjectProviderInputTimelineInput,
	boundary: ProviderInputWindowBoundary,
): string {
	const ordinal = input.timelineHistory.filter((event) => event.kind === "window_boundary").length + 1;
	const digest = modelInputSha256({
		session_id: input.sessionId,
		turn_id: input.turnId,
		provider_step: input.providerStep,
		boundary,
		ordinal,
	}).slice(0, 24);
	return `window-${ordinal}-${digest}`;
}

function createBoundaryEvent(
	input: ProjectProviderInputTimelineInput,
	windowId: string,
	boundary: ProviderInputWindowBoundary,
): ProviderInputTimelineEvent {
	return Object.freeze({
		eventId: timelineEventId({ window_id: windowId, boundary }),
		sessionId: input.sessionId,
		windowId,
		turnId: input.turnId,
		providerStep: input.providerStep,
		kind: "window_boundary",
		boundary,
		contentSha256: modelInputSha256({ window_id: windowId, boundary }),
		createdAt: input.createdAt,
	});
}

function createConversationTimelineEvent(input: {
	readonly input: ProjectProviderInputTimelineInput;
	readonly windowId: string;
	readonly item: CanonicalConversationItem;
	readonly sourceIndex: number;
}): ProviderInputTimelineEvent {
	const contentSha256 = modelInputSha256(input.item);
	return Object.freeze({
		eventId: timelineEventId({
			window_id: input.windowId,
			kind: "conversation_item",
			source_index: input.sourceIndex,
			content_sha256: contentSha256,
		}),
		sessionId: input.input.sessionId,
		windowId: input.windowId,
		turnId: input.input.turnId,
		providerStep: input.input.providerStep,
		kind: "conversation_item",
		item: input.item,
		sourceIndex: input.sourceIndex,
		contentSha256,
		createdAt: input.input.createdAt,
	});
}

function createContextTimelineEvent(input: {
	readonly input: ProjectProviderInputTimelineInput;
	readonly windowId: string;
	readonly event: ModelContextEvent;
	readonly timelineHistory: readonly ProviderInputTimelineEvent[];
}): ProviderInputTimelineEvent {
	const previousContext = input.event.supersedesEventId
		? input.input.contextHistory.find((event) => event.eventId === input.event.supersedesEventId)
		: undefined;
	const previousTimeline = input.event.supersedesEventId
		? [...input.timelineHistory].reverse().find((event) => (
			event.modelContextEventId === input.event.supersedesEventId
		))
		: undefined;
	const item = input.event.tombstone
		? inactiveContextItem(input.event, previousContext, previousTimeline)
		: activeContextItem(input.event, previousTimeline);
	const contentSha256 = modelInputSha256(item);
	const kind = input.event.tombstone ? "context_tombstone" : "context_update";
	return Object.freeze({
		eventId: timelineEventId({
			window_id: input.windowId,
			kind,
			model_context_event_id: input.event.eventId,
			content_sha256: contentSha256,
		}),
		sessionId: input.input.sessionId,
		windowId: input.windowId,
		turnId: input.input.turnId,
		providerStep: input.input.providerStep,
		kind,
		item,
		modelContextEventId: input.event.eventId,
		contentSha256,
		createdAt: input.input.createdAt,
	});
}

function activeContextItem(
	event: ModelContextEvent,
	previousTimeline: ProviderInputTimelineEvent | undefined,
): Extract<CanonicalConversationItem, { readonly type: "context" }> {
	const fragment = event.fragment;
	if (!fragment) throw new TypeError("active model context event is missing its fragment");
	return Object.freeze({
		type: "context",
		text: fragment.content,
		metadata: Object.freeze({
			kind: fragment.kind as CanonicalContextKind,
			role: fragment.role,
			cacheClass: fragment.cacheClass,
			durability: "persistent",
			scope: fragment.scope,
			sourceId: contextSourceId(event),
			contentSha256: fragment.contentSha256,
			contentLength: fragment.content.length,
			...(previousTimeline ? { supersedesItemId: previousTimeline.eventId } : {}),
		}),
	});
}

function inactiveContextItem(
	event: ModelContextEvent,
	previousContext: ModelContextEvent | undefined,
	previousTimeline: ProviderInputTimelineEvent | undefined,
): Extract<CanonicalConversationItem, { readonly type: "context" }> {
	const fragment = previousContext?.fragment;
	const kind = (fragment?.kind ?? "runtime_context_reminder") as CanonicalContextKind;
	const text = [
		`<context_update kind="${kind}" status="inactive">`,
		`The previous ${kind} context is no longer active.`,
		"</context_update>",
	].join("");
	return Object.freeze({
		type: "context",
		text,
		metadata: Object.freeze({
			kind,
			role: fragment?.role ?? "user",
			cacheClass: fragment?.cacheClass ?? "dynamic",
			durability: "persistent",
			scope: fragment?.scope ?? "turn",
			sourceId: contextSourceId(event),
			contentSha256: modelInputSha256(text),
			contentLength: text.length,
			...(previousTimeline ? { supersedesItemId: previousTimeline.eventId } : {}),
			tombstone: true,
		}),
	});
}

function insertContextBeforeCurrentUser(input: {
	readonly conversationEvents: readonly ProviderInputTimelineEvent[];
	readonly contextEvents: readonly ProviderInputTimelineEvent[];
	readonly conversationStart: number;
	readonly history: readonly CanonicalConversationItem[];
	readonly currentUserRequest: string;
}): readonly ProviderInputTimelineEvent[] {
	const currentIndex = currentUserIndex(input.history, input.currentUserRequest);
	if (currentIndex < input.conversationStart) {
		return Object.freeze([...input.conversationEvents, ...input.contextEvents]);
	}
	const localIndex = currentIndex - input.conversationStart;
	return Object.freeze([
		...input.conversationEvents.slice(0, localIndex),
		...input.contextEvents,
		...input.conversationEvents.slice(localIndex),
	]);
}

function currentUserIndex(
	history: readonly CanonicalConversationItem[],
	currentUserRequest: string,
): number {
	if (!currentUserRequest) return -1;
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const item = history[index];
		if (item?.type === "user" && item.text === currentUserRequest) return index;
	}
	return -1;
}

function activeContextEvent(
	history: readonly ModelContextEvent[],
	fragment: InstructionFragment,
): ModelContextEvent {
	const event = [...history].reverse().find((candidate) => (
		candidate.sectionKey === fragment.key
		&& !candidate.tombstone
		&& candidate.fragment?.contentSha256 === fragment.contentSha256
	));
	if (!event) throw new TypeError("active model context event is unavailable for timeline bootstrap");
	return event;
}

function requiredItem(event: ProviderInputTimelineEvent): CanonicalConversationItem {
	if (!event.item) throw new TypeError("provider input timeline item is missing");
	return event.item;
}

function requiredWindowId(events: readonly ProviderInputTimelineEvent[]): string {
	const windowId = events[0]?.windowId;
	if (!windowId) throw new TypeError("provider input timeline has no active window");
	return windowId;
}

function isExactPrefix(
	prefix: readonly CanonicalConversationItem[],
	value: readonly CanonicalConversationItem[],
): boolean {
	return prefix.length <= value.length && prefix.every((item, index) => (
		stableModelInputJson(item) === stableModelInputJson(value[index])
	));
}

function introducesCompaction(
	history: readonly CanonicalConversationItem[],
	priorItems: readonly CanonicalConversationItem[],
): boolean {
	const prior = new Set(compactionSummaries(priorItems));
	return compactionSummaries(history).some((summary) => !prior.has(summary));
}

function compactionSummaries(items: readonly CanonicalConversationItem[]): readonly string[] {
	return items.flatMap((item) => (
		item.type === "user" && item.text.startsWith("[compact-summary]\n") ? [item.text] : []
	));
}

function staticBootstrapItems(
	events: readonly ProviderInputTimelineEvent[],
): readonly CanonicalConversationItem[] {
	const items: CanonicalConversationItem[] = [];
	for (const event of events) {
		if (event.kind === "window_boundary") continue;
		if (event.kind !== "context_update" || event.item?.type !== "context"
			|| event.item.metadata.cacheClass !== "static") {
			break;
		}
		items.push(event.item);
	}
	return Object.freeze(items);
}

function contextSourceId(event: ModelContextEvent): string {
	return `ctx-${modelInputSha256({ event_id: event.eventId }).slice(0, 24)}`;
}

function timelineEventId(value: unknown): string {
	return `timeline-${modelInputSha256(value)}`;
}

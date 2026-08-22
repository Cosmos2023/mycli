import { projectTranscript } from "@mycli/storage";
import type {
	HistoryItemWindow,
	TranscriptItem,
} from "@mycli/storage";

const SNAPSHOT_PROJECTED_ITEM_LIMIT = 500;
const SNAPSHOT_HISTORY_RAW_ROW_LIMIT = 2_000;
const SNAPSHOT_ROLLOUT_RAW_ROW_LIMIT = 2_000;
const COMPLETE_TRANSCRIPT_LIMIT = Number.MAX_SAFE_INTEGER;
const TRANSCRIPT_PAGE_MAX_ITEMS = 500;
const TRANSCRIPT_RAW_WINDOW_SIZE = 2_000;
const TRANSCRIPT_CURSOR_PREFIX = "v1.";

export interface LegacyReadableTranscriptStore {
	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	loadTurnRollouts(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	loadRecentHistoryItems(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[];
	loadRecentTurnRollouts(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[];
	loadHistoryItemWindow(
		sessionId: string,
		beforeSequence: number | undefined,
		limit: number,
	): HistoryItemWindow;
	loadTurnRolloutsForTurns(
		sessionId: string,
		turnIds: readonly string[],
	): readonly Readonly<Record<string, unknown>>[];
}

export interface NormalizedReadableTranscriptStore {
	hasTranscriptEvents(sessionId: string): boolean;
	loadReadableTranscript(sessionId: string): readonly TranscriptItem[];
	loadRecentReadableTranscript(sessionId: string): readonly TranscriptItem[];
	loadReadableTranscriptPage(
		sessionId: string,
		options?: Readonly<{ readonly beforeSequence?: number; readonly limit?: number }>,
	): Readonly<{
		readonly items: readonly TranscriptItem[];
		readonly nextBeforeSequence: number | null;
	}>;
}

export type ReadableTranscriptStore =
	| LegacyReadableTranscriptStore
	| NormalizedReadableTranscriptStore;

export interface ReadableSessionTranscript {
	readonly hasCanonicalHistory: boolean;
	readonly items: readonly TranscriptItem[];
}

export interface ReadableSessionTranscriptPage {
	readonly hasCanonicalHistory: boolean;
	readonly items: readonly TranscriptItem[];
	readonly nextBefore: string | null;
}

export function projectReadableSessionTranscript(
	store: ReadableTranscriptStore,
	sessionId: string,
): ReadableSessionTranscript {
	if (isNormalizedStore(store)) {
		return Object.freeze({
			hasCanonicalHistory: store.hasTranscriptEvents(sessionId),
			items: store.loadReadableTranscript(sessionId),
		});
	}
	const history = store.loadHistoryItems(sessionId);
	return Object.freeze({
		hasCanonicalHistory: history.length > 0,
		items: projectTranscript(history, store.loadTurnRollouts(sessionId), {
			limit: COMPLETE_TRANSCRIPT_LIMIT,
		}),
	});
}

export function projectRecentSessionTranscript(
	store: ReadableTranscriptStore,
	sessionId: string,
): ReadableSessionTranscript {
	if (isNormalizedStore(store)) {
		return Object.freeze({
			hasCanonicalHistory: store.hasTranscriptEvents(sessionId),
			items: store.loadRecentReadableTranscript(sessionId),
		});
	}
	const recentHistory = store.loadRecentHistoryItems(
		sessionId,
		SNAPSHOT_HISTORY_RAW_ROW_LIMIT + 1,
	);
	const historyWindow = recentHistory.length > SNAPSHOT_HISTORY_RAW_ROW_LIMIT
		? withoutPartialEarliestTurn(
			recentHistory.slice(-SNAPSHOT_HISTORY_RAW_ROW_LIMIT),
			recentHistory.at(-(SNAPSHOT_HISTORY_RAW_ROW_LIMIT + 1)),
		)
		: recentHistory;
	return Object.freeze({
		hasCanonicalHistory: recentHistory.length > 0,
		items: projectTranscript(
			historyWindow,
			store.loadRecentTurnRollouts(sessionId, SNAPSHOT_ROLLOUT_RAW_ROW_LIMIT),
			{ limit: SNAPSHOT_PROJECTED_ITEM_LIMIT },
		),
	});
}

export function projectReadableSessionTranscriptPage(
	store: ReadableTranscriptStore,
	sessionId: string,
	options: { readonly before?: string; readonly limit?: number } = {},
): ReadableSessionTranscriptPage {
	const limit = transcriptPageLimit(options.limit);
	let beforeSequence = decodeTranscriptCursor(options.before);
	if (isNormalizedStore(store)) {
		const page = store.loadReadableTranscriptPage(sessionId, {
			...(beforeSequence === undefined ? {} : { beforeSequence }),
			limit,
		});
		return Object.freeze({
			hasCanonicalHistory: store.hasTranscriptEvents(sessionId),
			items: page.items,
			nextBefore: page.nextBeforeSequence === null
				? null
				: encodeTranscriptCursor(page.nextBeforeSequence),
		});
	}
	let hasCanonicalHistory = beforeSequence !== undefined;
	let pending: HistoryGroup | undefined;
	const visibleGroups: VisibleHistoryGroup[] = [];
	let exhausted = false;

	while (projectedItemCount(visibleGroups) < limit && !exhausted) {
		const window = store.loadHistoryItemWindow(
			sessionId,
			beforeSequence,
			TRANSCRIPT_RAW_WINDOW_SIZE,
		);
		if (window.items.length === 0) {
			exhausted = true;
			break;
		}
		hasCanonicalHistory = true;
		beforeSequence = window.items.at(-1)!.sequenceNo;
		const grouped = completeHistoryGroups(window.items, pending);
		pending = grouped.pending;
		if (!window.hasMore && pending) {
			grouped.complete.push(pending);
			pending = undefined;
		}
		visibleGroups.push(...projectVisibleGroups(store, sessionId, grouped.complete));
		exhausted = !window.hasMore;
	}

	const selected: VisibleHistoryGroup[] = [];
	let selectedItems = 0;
	for (const group of visibleGroups) {
		selected.push(group);
		selectedItems += group.items.length;
		if (selectedItems >= limit) break;
	}
	const items = Object.freeze(selected.reverse().flatMap((group) => group.items));
	const oldestSequence = selected.reduce(
		(value, group) => Math.min(value, group.oldestSequence),
		Number.MAX_SAFE_INTEGER,
	);
	const hasPotentiallyOlderRows = selected.length > 0 && (
		!exhausted || pending !== undefined || selected.length < visibleGroups.length
	);
	return Object.freeze({
		hasCanonicalHistory,
		items,
		nextBefore: hasPotentiallyOlderRows ? encodeTranscriptCursor(oldestSequence) : null,
	});
}

function projectVisibleGroups(
	store: LegacyReadableTranscriptStore,
	sessionId: string,
	groups: readonly HistoryGroup[],
): readonly VisibleHistoryGroup[] {
	if (groups.length === 0) return [];
	const turnIds = groups.flatMap((group) => group.turnId ? [group.turnId] : []);
	const rollouts = store.loadTurnRolloutsForTurns(sessionId, turnIds);
	const rolloutsByTurn = Map.groupBy(rollouts, (rollout) => turnId(rollout) ?? "");
	return groups.flatMap((group): VisibleHistoryGroup[] => {
		const history = [...group.items].reverse().map((item) => item.payload);
		const items = projectTranscript(
			history,
			group.turnId ? rolloutsByTurn.get(group.turnId) ?? [] : [],
			{ limit: COMPLETE_TRANSCRIPT_LIMIT },
		);
		return items.length === 0 ? [] : [{ oldestSequence: group.oldestSequence, items }];
	});
}

function isNormalizedStore(
	store: ReadableTranscriptStore,
): store is NormalizedReadableTranscriptStore {
	return "loadReadableTranscript" in store
		&& typeof store.loadReadableTranscript === "function";
}

interface HistoryGroup {
	readonly turnId?: string;
	readonly items: Array<HistoryItemWindow["items"][number]>;
	oldestSequence: number;
}

interface VisibleHistoryGroup {
	readonly oldestSequence: number;
	readonly items: readonly TranscriptItem[];
}

function completeHistoryGroups(
	items: HistoryItemWindow["items"],
	pending: HistoryGroup | undefined,
): { complete: HistoryGroup[]; pending: HistoryGroup | undefined } {
	const complete: HistoryGroup[] = [];
	let current = pending;
	for (const item of items) {
		const itemTurnId = turnId(item.payload);
		if (current && sameHistoryGroup(current, itemTurnId, item.sequenceNo)) {
			current.items.push(item);
			current.oldestSequence = item.sequenceNo;
			continue;
		}
		if (current) complete.push(current);
		current = {
			...(itemTurnId ? { turnId: itemTurnId } : {}),
			items: [item],
			oldestSequence: item.sequenceNo,
		};
	}
	return { complete, pending: current };
}

function sameHistoryGroup(group: HistoryGroup, itemTurnId: string | undefined, sequenceNo: number): boolean {
	return group.turnId !== undefined
		? group.turnId === itemTurnId
		: itemTurnId === undefined && group.oldestSequence === sequenceNo + 1;
}

function projectedItemCount(groups: readonly VisibleHistoryGroup[]): number {
	return groups.reduce((count, group) => count + group.items.length, 0);
}

function transcriptPageLimit(value: number | undefined): number {
	if (value === undefined) return TRANSCRIPT_PAGE_MAX_ITEMS;
	if (!Number.isSafeInteger(value) || value < 1 || value > TRANSCRIPT_PAGE_MAX_ITEMS) {
		throw new RangeError(`limit must be an integer between 1 and ${TRANSCRIPT_PAGE_MAX_ITEMS}`);
	}
	return value;
}

function encodeTranscriptCursor(sequenceNo: number): string {
	return `${TRANSCRIPT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ s: sequenceNo }), "utf8").toString("base64url")}`;
}

function decodeTranscriptCursor(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!value.startsWith(TRANSCRIPT_CURSOR_PREFIX)) throw new RangeError("invalid transcript cursor");
	try {
		const parsed = JSON.parse(
			Buffer.from(value.slice(TRANSCRIPT_CURSOR_PREFIX.length), "base64url").toString("utf8"),
		) as unknown;
		const sequenceNo = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? Reflect.get(parsed, "s")
			: undefined;
		if (typeof sequenceNo !== "number" || !Number.isSafeInteger(sequenceNo) || sequenceNo < 1) {
			throw new Error("invalid sequence");
		}
		return sequenceNo;
	} catch {
		throw new RangeError("invalid transcript cursor");
	}
}

function withoutPartialEarliestTurn(
	items: readonly Readonly<Record<string, unknown>>[],
	precedingItem: Readonly<Record<string, unknown>> | undefined,
): readonly Readonly<Record<string, unknown>>[] {
	const earliestTurnId = turnId(items[0]);
	if (!earliestTurnId) return items.slice(1);
	if (turnId(precedingItem) !== earliestTurnId) return items;
	const firstCompleteTurnIndex = items.findIndex((item) => turnId(item) !== earliestTurnId);
	return firstCompleteTurnIndex < 0 ? [] : items.slice(firstCompleteTurnIndex);
}

function turnId(item: Readonly<Record<string, unknown>> | undefined): string | undefined {
	return typeof item?.turn_id === "string" && item.turn_id ? item.turn_id : undefined;
}

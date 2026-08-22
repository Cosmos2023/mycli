import assert from "node:assert/strict";
import test from "node:test";
import {
	projectReadableSessionTranscript,
	projectReadableSessionTranscriptPage,
	projectRecentSessionTranscript,
	type NormalizedReadableTranscriptStore,
	type ReadableTranscriptStore,
} from "../src/node-runtime/readable-session-transcript.ts";

test("readable transcript rebuilds complete visible history and merges tool lifecycles", () => {
	const history = [
		historyItem("old", "old-turn", "assistant_message", "old"),
		historyItem("call", "tool-turn", "tool_call", "", "call-1"),
		historyItem("result", "tool-turn", "tool_result", "contents", "call-1"),
		...Array.from({ length: 2_100 }, (_, index) => historyItem(
			`message-${index}`,
			`turn-${index}`,
			"assistant_message",
			`message-${index}`,
		)),
	];
	const calls: Array<"history" | "rollouts"> = [];
	const store = fakeStore(history, [], calls);

	const result = projectReadableSessionTranscript(store, "session-1");

	assert.equal(result.hasCanonicalHistory, true);
	assert.deepEqual(calls, ["history", "rollouts"]);
	assert.equal(result.items.length, 2_102);
	assert.deepEqual(result.items.slice(0, 2).map((item) => ({
		id: item.id,
		callId: item.call_id,
		status: item.status,
		output: item.output,
	})), [{
		id: "old",
		callId: undefined,
		status: undefined,
		output: undefined,
	}, {
		id: "call",
		callId: "call-1",
		status: "completed",
		output: "contents",
	}]);
	assert.equal(result.items.at(-1)?.id, "message-2099");
});

test("readable transcript hides compaction replacements while retaining turns across windows", () => {
	const history = [
		historyItem("user-1", "turn-1", "user_message", "before first compact"),
		historyItem("assistant-1", "turn-1", "assistant_message", "first answer"),
		compactionBoundary("compact-1", "turn-1", "private compact replacement one"),
		historyItem("user-2", "turn-2", "user_message", "between compacts"),
		historyItem("assistant-2", "turn-2", "assistant_message", "second answer"),
		compactionBoundary("compact-2", "turn-2", "private compact replacement two"),
		historyItem("user-3", "turn-3", "user_message", "after latest compact"),
	];
	const result = projectReadableSessionTranscript(fakeStore(history), "session-1");

	assert.deepEqual(result.items.map((item) => item.text), [
		"before first compact",
		"first answer",
		"between compacts",
		"second answer",
		"after latest compact",
	]);
	assert.equal(JSON.stringify(result.items).includes("private compact replacement"), false);
});

test("readable transcript reports whether canonical history exists", () => {
	assert.deepEqual(projectReadableSessionTranscript(fakeStore([]), "session-1"), {
		hasCanonicalHistory: false,
		items: [],
	});
});

test("readable transcript first page reports whether canonical history exists", () => {
	assert.equal(
		projectReadableSessionTranscriptPage(fakeStore([]), "session-1").hasCanonicalHistory,
		false,
	);
	assert.equal(
		projectReadableSessionTranscriptPage(
			fakeStore([compactionBoundary("compact", "turn-1", "private")]),
			"session-1",
		).hasCanonicalHistory,
		true,
	);
});

test("recent snapshot projection stays bounded without changing complete transcript", () => {
	const history = Array.from({ length: 800 }, (_, index) => historyItem(
		`message-${index}`,
		`turn-${index}`,
		"assistant_message",
		`message-${index}`,
	));
	const store = fakeStore(history);

	const recent = projectRecentSessionTranscript(store, "session-1");
	const complete = projectReadableSessionTranscript(store, "session-1");

	assert.equal(recent.items.length, 500);
	assert.equal(recent.items[0]?.id, "message-300");
	assert.equal(complete.items.length, 800);
	assert.equal(complete.items[0]?.id, "message-0");
});

test("readable transcript pages reach older history through opaque cursors", () => {
	const history = Array.from({ length: 800 }, (_, index) => historyItem(
		`message-${index}`,
		`turn-${index}`,
		"assistant_message",
		`message-${index}`,
	));
	const store = fakeStore(history);

	const latest = projectReadableSessionTranscriptPage(store, "session-1", { limit: 500 });
	assert.equal(latest.items.length, 500);
	assert.equal(latest.items[0]?.id, "message-300");
	assert.match(latest.nextBefore ?? "", /^v1\./u);

	const earlier = projectReadableSessionTranscriptPage(store, "session-1", {
		before: latest.nextBefore ?? undefined,
		limit: 500,
	});
	assert.equal(earlier.items.length, 300);
	assert.equal(earlier.items[0]?.id, "message-0");
	assert.equal(earlier.nextBefore, null);
});

test("readable transcript pages keep a tool lifecycle within one turn", () => {
	const history = [
		historyItem("old", "old-turn", "assistant_message", "old"),
		historyItem("call", "tool-turn", "tool_call", "", "call-1"),
		historyItem("result", "tool-turn", "tool_result", "contents", "call-1"),
		historyItem("new", "new-turn", "assistant_message", "new"),
	];
	const store = fakeStore(history);

	const latest = projectReadableSessionTranscriptPage(store, "session-1", { limit: 1 });
	assert.deepEqual(latest.items.map((item) => item.id), ["new"]);
	const middle = projectReadableSessionTranscriptPage(store, "session-1", {
		before: latest.nextBefore ?? undefined,
		limit: 1,
	});
	assert.deepEqual(middle.items.map((item) => ({ id: item.id, output: item.output })), [
		{ id: "call", output: "contents" },
	]);
	const oldest = projectReadableSessionTranscriptPage(store, "session-1", {
		before: middle.nextBefore ?? undefined,
		limit: 1,
	});
	assert.deepEqual(oldest.items.map((item) => item.id), ["old"]);
	assert.equal(oldest.nextBefore, null);
});

test("readable transcript pages do not split a turn across raw SQLite windows", () => {
	const oversizedTurn = Array.from({ length: 2_050 }, (_, index) => historyItem(
		`oversized-${index}`,
		"oversized-turn",
		"assistant_message",
		`oversized ${index}`,
	));
	const store = fakeStore([
		historyItem("old", "old-turn", "assistant_message", "old"),
		...oversizedTurn,
		historyItem("new", "new-turn", "assistant_message", "new"),
	]);

	const latest = projectReadableSessionTranscriptPage(store, "session-1", { limit: 1 });
	assert.deepEqual(latest.items.map((item) => item.id), ["new"]);

	const oversized = projectReadableSessionTranscriptPage(store, "session-1", {
		before: latest.nextBefore ?? undefined,
		limit: 1,
	});
	assert.equal(oversized.items.length, 2_050);
	assert.equal(oversized.items[0]?.id, "oversized-0");
	assert.equal(oversized.items.at(-1)?.id, "oversized-2049");

	const oldest = projectReadableSessionTranscriptPage(store, "session-1", {
		before: oversized.nextBefore ?? undefined,
		limit: 1,
	});
	assert.deepEqual(oldest.items.map((item) => item.id), ["old"]);
	assert.equal(oldest.nextBefore, null);
});

test("readable transcript pages scan through hidden compaction-only windows", () => {
	const history = [
		historyItem("old", "old-turn", "assistant_message", "old"),
		...Array.from({ length: 2_100 }, (_, index) => compactionBoundary(
			`compact-${index}`,
			`compact-turn-${index}`,
			`private compact replacement ${index}`,
		)),
		historyItem("new", "new-turn", "assistant_message", "new"),
	];
	const store = fakeStore(history);

	const latest = projectReadableSessionTranscriptPage(store, "session-1", { limit: 1 });
	assert.deepEqual(latest.items.map((item) => item.id), ["new"]);
	assert.match(latest.nextBefore ?? "", /^v1\./u);

	const oldest = projectReadableSessionTranscriptPage(store, "session-1", {
		before: latest.nextBefore ?? undefined,
		limit: 1,
	});
	assert.deepEqual(oldest.items.map((item) => item.id), ["old"]);
	assert.equal(oldest.nextBefore, null);
	assert.equal(JSON.stringify(oldest.items).includes("private compact replacement"), false);
});

test("readable transcript pages reject invalid cursors and limits", () => {
	const store = fakeStore([historyItem("one", "turn-one", "assistant_message", "one")]);
	assert.throws(
		() => projectReadableSessionTranscriptPage(store, "session-1", { before: "message-one" }),
		/invalid transcript cursor/u,
	);
	assert.throws(
		() => projectReadableSessionTranscriptPage(store, "session-1", { limit: 501 }),
		/between 1 and 500/u,
	);
});

test("readable transcript routes normalized complete, recent, and paged projections", () => {
	const calls: string[] = [];
	const completeItems = [{ id: "complete", type: "assistant_message" as const, text: "complete" }];
	const recentItems = [{ id: "recent", type: "assistant_message" as const, text: "recent" }];
	const store: NormalizedReadableTranscriptStore = {
		hasTranscriptEvents: () => true,
		loadReadableTranscript: () => {
			calls.push("complete");
			return completeItems;
		},
		loadRecentReadableTranscript: () => {
			calls.push("recent");
			return recentItems;
		},
		loadReadableTranscriptPage: (_sessionId, options) => {
			calls.push(`page:${options?.beforeSequence ?? "latest"}:${options?.limit ?? "default"}`);
			return options?.beforeSequence === undefined
				? { items: recentItems, nextBeforeSequence: 12 }
				: { items: completeItems, nextBeforeSequence: null };
		},
	};

	assert.deepEqual(projectReadableSessionTranscript(store, "session-1"), {
		hasCanonicalHistory: true,
		items: completeItems,
	});
	assert.deepEqual(projectRecentSessionTranscript(store, "session-1"), {
		hasCanonicalHistory: true,
		items: recentItems,
	});
	const latest = projectReadableSessionTranscriptPage(store, "session-1", { limit: 20 });
	assert.deepEqual(latest.items, recentItems);
	assert.match(latest.nextBefore ?? "", /^v1\./u);
	const older = projectReadableSessionTranscriptPage(store, "session-1", {
		before: latest.nextBefore ?? undefined,
		limit: 20,
	});
	assert.deepEqual(older.items, completeItems);
	assert.equal(older.nextBefore, null);
	assert.deepEqual(calls, ["complete", "recent", "page:latest:20", "page:12:20"]);
});

function fakeStore(
	history: readonly Readonly<Record<string, unknown>>[],
	rollouts: readonly Readonly<Record<string, unknown>>[] = [],
	calls: Array<"history" | "rollouts"> = [],
): ReadableTranscriptStore {
	return {
		loadHistoryItems: () => {
			calls.push("history");
			return history;
		},
		loadTurnRollouts: () => {
			calls.push("rollouts");
			return rollouts;
		},
		loadRecentHistoryItems: (_sessionId, limit) => history.slice(-limit),
		loadRecentTurnRollouts: (_sessionId, limit) => rollouts.slice(-limit),
		loadHistoryItemWindow: (_sessionId, beforeSequence, limit) => {
			const sequenced = history.map((payload, index) => ({
				sequenceNo: index + 1,
				payload,
			}));
			const before = beforeSequence ?? sequenced.length + 1;
			const rows = sequenced.filter((item) => item.sequenceNo < before).slice(-limit).reverse();
			return {
				items: rows,
				hasMore: sequenced.some((item) => item.sequenceNo < (rows.at(-1)?.sequenceNo ?? before)),
			};
		},
		loadTurnRolloutsForTurns: (_sessionId, turnIds) => {
			const ids = new Set(turnIds);
			return rollouts.filter((rollout) => (
				typeof rollout.turn_id === "string" && ids.has(rollout.turn_id)
			));
		},
	};
}

function compactionBoundary(
	id: string,
	turnId: string,
	replacementText: string,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		id,
		turn_id: turnId,
		type: "compaction_boundary",
		summary: replacementText,
		replacement_messages: [{ role: "user", content: replacementText }],
		metadata: {},
	});
}

function historyItem(
	id: string,
	turnId: string,
	type: string,
	text: string,
	callId?: string,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		id,
		turn_id: turnId,
		type,
		text,
		...(callId ? { call_id: callId, tool_name: "Read" } : {}),
		metadata: type === "tool_result"
			? { transcript_content: text, status: "completed" }
			: { status: "running" },
	});
}

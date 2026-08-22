import assert from "node:assert/strict";
import test from "node:test";
import { TokenCounter } from "../src/token-counter.ts";
import type {
	FileMemory,
	ForgetMemoryResult,
	RememberMemoryInput,
} from "../src/memory-store.ts";
import {
	extractExplicitMemoryRequest,
	MemoryContextService,
	type MemoryStoreContract,
} from "../src/memory-context-service.ts";

test("loads session summaries and deduplicates normalized kind-key-value triples", async () => {
	const store = new FakeMemoryStore([
		memory("preference.md", "user", "Use tabs"),
	]);
	const summaries = ["Completed parser", " completed   parser ", "Completed tests"];
	const service = new MemoryContextService({
		store,
		sessionStore: { loadRecentSessionSummaries: () => summaries },
		selector: { select: async (_query, memories) => memories },
	});

	const context = await service.collect({
		userMessage: "parser",
		sessionId: "session-1",
		enabled: true,
	});

	assert.deepEqual(context.records.map((record) => [record.kind, record.key, record.value]), [
		["user", "preference.md", "Use tabs"],
		["session_summary", "recent", "Completed parser"],
		["session_summary", "recent", "Completed tests"],
	]);
	assert.match(context.item?.text ?? "", /<memory-reference>/u);
	assert.match(context.item?.text ?? "", /not the current user request or new user input/u);
	assert.match(context.item?.text ?? "", /<\/memory-reference>/u);
});

test("requests only the bounded recent session summary window", async () => {
	let requestedLimit: number | undefined;
	const service = new MemoryContextService({
		store: new FakeMemoryStore([]),
		sessionStore: {
			loadRecentSessionSummaries: (_sessionId, limit) => {
				requestedLimit = limit;
				return ["recent summary"];
			},
		},
	});

	const context = await service.collect({
		userMessage: "continue",
		sessionId: "session-1",
		enabled: true,
	});

	assert.equal(requestedLimit, 8);
	assert.deepEqual(context.records.map((record) => record.value), ["recent summary"]);
});

test("bounds each record and the aggregate context with the Task 8 token counter", async () => {
	const store = new FakeMemoryStore([
		memory("one.md", "project", "1234567890"),
		memory("two.md", "reference", "abcdefghij"),
	]);
	const tokenCounter = new TokenCounter({
		loadEncoder: () => ({ encode: (text) => Array.from(text, (_, index) => index) }),
	});
	const service = new MemoryContextService({
		store,
		sessionStore: { loadRecentSessionSummaries: () => ["summary-too-long"] },
		selector: { select: async (_query, memories) => memories },
		tokenCounter,
		perRecordTokenBudget: 8,
		aggregateTokenBudget: 120,
	});

	const context = await service.collect({
		userMessage: "anything",
		sessionId: "session-1",
		enabled: true,
	});

	assert.equal(context.records.every((record) => tokenCounter.count(record.value) <= 8), true);
	assert.equal(tokenCounter.count(context.item?.text ?? "") <= 120, true);
	assert.match(context.item?.text ?? "", /truncated/u);
});

test("disabled memory bypasses storage, selection, summaries, injection, and explicit actions", async () => {
	const store = new FakeMemoryStore([memory("one.md", "user", "value")]);
	let summaryCalls = 0;
	let selectorCalls = 0;
	const service = new MemoryContextService({
		store,
		sessionStore: { loadRecentSessionSummaries: () => { summaryCalls += 1; return ["summary"]; } },
		selector: { select: async () => { selectorCalls += 1; return []; } },
	});

	const context = await service.collect({
		userMessage: "remember that I prefer tabs",
		sessionId: "session-1",
		enabled: false,
	});
	const actions = await service.applyExplicitActions({
		userMessage: "remember that I prefer tabs",
		enabled: false,
	});

	assert.deepEqual(context, { records: [] });
	assert.deepEqual(actions, []);
	assert.equal(store.scanCalls, 0);
	assert.equal(store.remembered.length, 0);
	assert.equal(summaryCalls, 0);
	assert.equal(selectorCalls, 0);
});

test("does not call selection for an empty memory set", async () => {
	const store = new FakeMemoryStore([]);
	let selectorCalls = 0;
	const service = new MemoryContextService({
		store,
		sessionStore: { loadRecentSessionSummaries: () => [] },
		selector: { select: async () => { selectorCalls += 1; return []; } },
	});

	assert.deepEqual(await service.collect({ userMessage: "query", sessionId: "s", enabled: true }), { records: [] });
	assert.equal(selectorCalls, 0);
});

test("ignores file memory on explicit request while retaining session summaries", async () => {
	const store = new FakeMemoryStore([
		memory("preference.md", "user", "Use tabs"),
	]);
	let selectorCalls = 0;
	const service = new MemoryContextService({
		store,
		sessionStore: { loadRecentSessionSummaries: () => ["Completed parser"] },
		selector: { select: async () => { selectorCalls += 1; return store.memories; } },
	});

	const context = await service.collect({
		userMessage: "Ignore memory and continue",
		sessionId: "session-1",
		enabled: true,
	});

	assert.equal(store.scanCalls, 0);
	assert.equal(selectorCalls, 0);
	assert.deepEqual(context.records.map((record) => [record.kind, record.value]), [
		["session_summary", "Completed parser"],
	]);
	assert.doesNotMatch(context.item?.text ?? "", /Use tabs/u);
});

test("recognizes English and Chinese remember and forget patterns with Python classification parity", () => {
	assert.deepEqual(extractExplicitMemoryRequest("Please remember that I prefer tabs."), {
		action: "remember",
		content: "I prefer tabs",
		kind: "user",
		name: "i prefer tabs",
		description: "I prefer tabs",
	});
	const project = extractExplicitMemoryRequest("请记住：项目 release deadline 是周五。");
	const reference = extractExplicitMemoryRequest("Remember https://grafana.example/dashboard");
	const feedback = extractExplicitMemoryRequest("Remember do not overwrite files");
	assert.equal(project?.action === "remember" ? project.kind : undefined, "project");
	assert.equal(reference?.action === "remember" ? reference.kind : undefined, "reference");
	assert.equal(feedback?.action === "remember" ? feedback.kind : undefined, "feedback");
	assert.deepEqual(extractExplicitMemoryRequest("Forget release notes."), {
		action: "forget",
		content: "release notes",
	});
	assert.deepEqual(extractExplicitMemoryRequest("删除记忆：发布计划。"), {
		action: "forget",
		content: "发布计划",
	});
	const long = extractExplicitMemoryRequest(`Remember ${"word ".repeat(40)}`);
	assert.equal(long?.action === "remember" && long.name.split(" ").length <= 6, true);
	assert.equal(long?.action === "remember" && long.description.length <= 140, true);
});

test("executes only direct explicit remember or forget actions", async () => {
	const store = new FakeMemoryStore([]);
	const service = new MemoryContextService({
		store,
		sessionStore: { loadRecentSessionSummaries: () => [] },
	});

	const saved = await service.applyExplicitActions({
		userMessage: "Remember that repo deadline is Friday.",
		enabled: true,
	});
	const forgotten = await service.applyExplicitActions({
		userMessage: "忘记：repo deadline。",
		enabled: true,
	});
	const ordinary = await service.applyExplicitActions({
		userMessage: "Tell me about the repo deadline.",
		enabled: true,
	});

	assert.deepEqual(saved, ["memory_saved:repo_deadline_is_friday.md"]);
	assert.deepEqual(forgotten, ["memory_forgot:repo_deadline_is_friday.md"]);
	assert.deepEqual(ordinary, []);
	assert.equal(store.remembered[0]?.kind, "project");
	assert.deepEqual(store.forgotten, ["repo deadline"]);
});

class FakeMemoryStore implements MemoryStoreContract {
	readonly remembered: RememberMemoryInput[] = [];
	readonly forgotten: string[] = [];
	scanCalls = 0;

	constructor(readonly memories: FileMemory[]) {}

	async loadEntrypoint() {
		return {
			content: "",
			lineCount: 0,
			byteCount: 0,
			wasLineTruncated: false,
			wasByteTruncated: false,
		};
	}

	async scan(): Promise<readonly FileMemory[]> {
		this.scanCalls += 1;
		return this.memories;
	}

	async remember(input: RememberMemoryInput): Promise<FileMemory> {
		this.remembered.push(input);
		const filename = `${input.name.replaceAll(" ", "_")}.md`;
		const saved = memory(filename, input.kind, input.content);
		this.memories.push(saved);
		return saved;
	}

	async forget(query: string): Promise<readonly ForgetMemoryResult[]> {
		this.forgotten.push(query);
		return [memory("repo_deadline_is_friday.md", "project", "repo deadline")];
	}
}

function memory(filename: string, kind: FileMemory["kind"], content: string): FileMemory {
	return {
		filename,
		mtime: 1,
		kind,
		name: filename.replace(/\.md$/u, ""),
		description: "",
		content,
	};
}

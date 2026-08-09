import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import type { ModelProvider } from "@mycli/providers";
import type { FileMemory } from "../src/memory-store.ts";
import {
	deterministicMemorySelection,
	MemorySelector,
} from "../src/memory-selector.ts";

test("uses Python-compatible weighted token matching and deterministic ordering", () => {
	const memories = [
		memory("filename-release.md", { name: "misc", mtime: 1 }),
		memory("misc.md", { name: "release", mtime: 2 }),
		memory("description.md", { description: "release", mtime: 3 }),
		memory("content.md", { content: "release", mtime: 4 }),
	];

	assert.deepEqual(
		deterministicMemorySelection("release", memories).map((item) => item.filename),
		["misc.md", "filename-release.md", "description.md", "content.md"],
	);

	const tied = [memory("b.md", { content: "release", mtime: 5 }), memory("a.md", { content: "release", mtime: 5 })];
	assert.deepEqual(
		deterministicMemorySelection("release", tied).map((item) => item.filename),
		["a.md", "b.md"],
	);
});

test("empty fallback query prefers recent user and feedback memories", () => {
	const memories = [
		memory("project.md", { kind: "project", mtime: 100 }),
		memory("user.md", { kind: "user", mtime: 2 }),
		memory("feedback.md", { kind: "feedback", mtime: 3 }),
	];

	assert.deepEqual(
		deterministicMemorySelection("", memories).map((item) => item.filename),
		["feedback.md", "user.md"],
	);
});

test("uses Python Unicode code-point order for deterministic filename ties", () => {
	const filenames = ["a.md", "A.md", "_.md", "-.md", "😀.md", "！.md"];
	const memories = filenames.map((filename) => memory(filename, { kind: "user", mtime: 1 }));

	assert.deepEqual(
		deterministicMemorySelection("", memories).map((item) => item.filename),
		["-.md", "A.md", "_.md", "a.md", "！.md"],
	);
});

test("falls back for invalid JSON, provider failure, and empty model selection", async () => {
	for (const behavior of ["invalid", "failure", "empty"] as const) {
		const provider = new SelectorProvider(behavior);
		const selector = createSelector(provider);
		const selected = await selector.select("release", [
			memory("release.md", { name: "release" }),
			memory("other.md"),
		]);
		assert.deepEqual(selected.map((item) => item.filename), ["release.md"]);
	}
});

test("validates, deduplicates, and limits model filenames against the in-memory allowlist", async () => {
	const provider = new SelectorProvider("valid", [
		"b.md",
		"../../outside.md",
		"b.md",
		"a.md",
		"c.md",
		"d.md",
		"e.md",
		"f.md",
	]);
	const selector = createSelector(provider);
	const memories = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"].map((name) => memory(name));

	const selected = await selector.select("anything", memories, { limit: 99 });

	assert.deepEqual(selected.map((item) => item.filename), ["b.md", "a.md", "c.md", "d.md", "e.md"]);
	assert.equal(provider.requests.length, 1);
	const request = provider.requests[0];
	assert.equal(request?.reasoningEffort, "none");
	assert.equal(request?.maxOutputTokens, 512);
	assert.deepEqual(request?.tools, []);
	assert.match(request?.instructions ?? "", /Return JSON only/u);
	assert.equal(request?.items?.length, 1);
	assert.equal(request?.items?.[0]?.type, "user");
	if (request?.items?.[0]?.type === "user") {
		assert.match(request.items[0].text, /anything/u);
		assert.match(request.items[0].text, /Available memory files/u);
	}
});

test("passes the caller abort signal to the selector provider request", async () => {
	const provider = new SelectorProvider("valid", ["a.md"]);
	const selector = createSelector(provider);
	const controller = new AbortController();

	await selector.select("anything", [memory("a.md")], {
		signal: controller.signal,
	});

	assert.equal(provider.signals[0], controller.signal);
});

test("does not call the model for empty memory or an empty query", async () => {
	const provider = new SelectorProvider("valid", ["user.md"]);
	const selector = createSelector(provider);

	assert.deepEqual(await selector.select("query", []), []);
	assert.deepEqual(
		(await selector.select("", [memory("user.md", { kind: "user" })])).map((item) => item.filename),
		["user.md"],
	);
	assert.equal(provider.requests.length, 0);
});

test("requires a completed non-empty selector response", async () => {
	for (const behavior of ["not_completed", "blank"] as const) {
		const provider = new SelectorProvider(behavior);
		const selector = createSelector(provider);
		const selected = await selector.select("release", [memory("release.md", { content: "release" })]);
		assert.deepEqual(selected.map((item) => item.filename), ["release.md"]);
	}
});

function createSelector(provider: ModelProvider): MemorySelector {
	return new MemorySelector({
		provider,
		providerConfig: {
			provider: "openai",
			protocol: "responses",
			model: "selector-model",
		},
	});
}

class SelectorProvider implements ModelProvider {
	readonly requests: ProviderRequest[] = [];
	readonly signals: AbortSignal[] = [];

	constructor(
		readonly behavior: "valid" | "invalid" | "failure" | "empty" | "not_completed" | "blank",
		readonly selected: readonly string[] = [],
	) {}

	async *stream(
		request: ProviderRequest,
		options: { readonly signal: AbortSignal },
	): AsyncIterable<ProviderEvent> {
		this.requests.push(request);
		this.signals.push(options.signal);
		if (this.behavior === "failure") throw new Error("provider unavailable");
		if (this.behavior === "not_completed") {
			yield { type: "text_delta", text: JSON.stringify({ selected_memories: this.selected }) };
			return;
		}
		if (this.behavior === "blank") {
			yield { type: "completed" };
			return;
		}
		const text = this.behavior === "invalid"
			? "not-json"
			: JSON.stringify({ selected_memories: this.behavior === "empty" ? [] : this.selected });
		yield { type: "text_delta", text };
		yield { type: "completed" };
	}
}

function memory(filename: string, overrides: Partial<FileMemory> = {}): FileMemory {
	return {
		filename,
		mtime: 1,
		name: filename.replace(/\.md$/u, ""),
		description: "",
		content: "",
		...overrides,
	};
}

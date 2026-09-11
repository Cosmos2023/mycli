import assert from "node:assert/strict";
import test from "node:test";
import type { MycliShellTranscriptBlock } from "../../src/model.ts";
import {
	createTranscriptProjection,
	projectTranscriptBlocks,
	projectTranscriptTail,
} from "../../src/transcript/transcript-projection.ts";

function message(id: string, text = id): MycliShellTranscriptBlock {
	return { id, kind: "message", message: { id, role: "assistant", text } };
}

function contextTool(
	id: string,
	options: { expanded?: boolean; mutating?: boolean } = {},
): MycliShellTranscriptBlock {
	return {
		id,
		kind: "tool",
		tool: {
			id,
			name: options.mutating ? "Write" : "Read",
			status: "success",
			presentation: "context",
			...options,
		},
	};
}

function fileChange(id: string): MycliShellTranscriptBlock {
	return {
		id,
		kind: "file_change",
		fileChange: {
			id,
			status: "success",
			summary: "Updated file",
			files: [],
		},
		message: { id, role: "system", text: "Updated file" },
	};
}

function subagent(id: string): MycliShellTranscriptBlock {
	return {
		id,
		kind: "subagent",
		subagent: {
			id,
			role: "explorer",
			status: "running",
			childSessionId: `child-${id}`,
		},
	};
}

function assertMatchesFullProjection(blocks: MycliShellTranscriptBlock[]): void {
	const expected = projectTranscriptBlocks(blocks);
	const previous = createTranscriptProjection(blocks.slice(0, -1));
	const update = projectTranscriptTail(blocks, previous);
	assert.deepEqual(update.projection.blocks, expected);
}

test("tail projection updates the last assistant without reading the stable transcript prefix", () => {
	const initial = Array.from({ length: 10_000 }, (_, index) => message(`message-${index}`));
	const previous = createTranscriptProjection(initial);
	const next = [...initial.slice(0, -1), message("message-9999", "updated tail")];
	const expected = projectTranscriptBlocks(next);
	let indexedReads = 0;
	const counted = new Proxy(next, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) indexedReads += 1;
			return Reflect.get(target, property, receiver);
		},
	});

	const update = projectTranscriptTail(counted, previous);

	assert.deepEqual(update.projection.blocks, expected);
	assert.equal(update.stablePrefixLength, 9_999);
	assert.ok(indexedReads <= 5, `expected bounded tail reads, received ${indexedReads}`);
	assert.equal(update.projection.blocks[5_000], expected[5_000]);
});

test("tail projection retains ordinary appended block identity without copying the prefix", () => {
	const initial = [message("one"), message("two")];
	const previous = createTranscriptProjection(initial);
	const firstProjected = previous.blocks[0];
	const projectedArray = previous.blocks;
	const next = [message("one"), message("two"), message("three")];

	const update = projectTranscriptTail(next, previous);

	assert.equal(update.stablePrefixLength, 2);
	assert.equal(update.projection.blocks, projectedArray);
	assert.equal(update.projection.blocks[0], firstProjected);
	assert.deepEqual(update.projection.blocks, projectTranscriptBlocks(next));
});

test("tail projection regroups a second context tool", () => {
	const first = contextTool("read-1");
	const blocks = [first, contextTool("read-2")];
	const update = projectTranscriptTail(blocks, createTranscriptProjection([first]));

	assert.equal(update.stablePrefixLength, 0);
	assert.equal(update.projection.blocks.length, 1);
	assert.equal(update.projection.blocks[0]?.kind, "tool_group");
	assert.deepEqual(update.projection.blocks, projectTranscriptBlocks(blocks));
});

test("tail projection preserves mutating and file-change grouping boundaries", () => {
	const readOne = contextTool("read-1");
	const write = contextTool("write-1", { mutating: true });
	const change = fileChange("change-1");
	const initial = [readOne, write, change, contextTool("read-2")];
	const blocks = [...initial, contextTool("read-3")];
	const update = projectTranscriptTail(blocks, createTranscriptProjection(initial));

	assert.equal(update.stablePrefixLength, 3);
	assert.deepEqual(update.projection.blocks, projectTranscriptBlocks(blocks));
	assert.deepEqual(update.projection.blocks.map((block) => block.kind), [
		"tool_group",
		"tool",
		"file_change",
		"tool_group",
	]);
});

test("tail projection respects subagent boundaries and can regroup after boundary replacement", () => {
	const readOne = contextTool("read-1");
	const agent = subagent("agent-1");
	const appended = [readOne, agent, contextTool("read-2")];
	const appendUpdate = projectTranscriptTail(appended, createTranscriptProjection([readOne, agent]));

	assert.deepEqual(appendUpdate.projection.blocks, projectTranscriptBlocks(appended));
	assert.deepEqual(appendUpdate.projection.blocks.map((block) => block.kind), ["tool_group", "tool_group"]);

	const replaced = [readOne, contextTool("read-2")];
	const replaceUpdate = projectTranscriptTail(replaced, createTranscriptProjection([readOne, agent]));
	assert.equal(replaceUpdate.stablePrefixLength, 0);
	assert.deepEqual(replaceUpdate.projection.blocks, projectTranscriptBlocks(replaced));
	assert.equal(replaceUpdate.projection.blocks[0]?.kind, "tool_group");
});

test("tail projection replays an expanded context run instead of collapsing it", () => {
	const initial = [contextTool("read-1", { expanded: true }), contextTool("read-2")];
	const blocks = [...initial, contextTool("read-3")];
	const update = projectTranscriptTail(blocks, createTranscriptProjection(initial));

	assert.equal(update.stablePrefixLength, 0);
	assert.deepEqual(update.projection.blocks, projectTranscriptBlocks(blocks));
	assert.deepEqual(update.projection.blocks.map((block) => block.kind), ["tool", "tool", "tool"]);
});

test("native reads and Shell searches share exploration groups across tail updates", () => {
	const search: MycliShellTranscriptBlock = {
		id: "search", kind: "bash", bash: { id: "search", command: "rg -n needle src", status: "running" },
	};
	const initial = [contextTool("read"), search];
	const projection = createTranscriptProjection(initial);
	assert.equal(projection.blocks.length, 1);
	assert.equal(projection.blocks[0]?.kind, "tool_group");
	const finished = { ...search, bash: { ...search.bash, status: "success" as const, outputPreview: "match" } };
	const next = [initial[0]!, finished];
	assert.deepEqual(projectTranscriptTail(next, projection).projection, createTranscriptProjection(next));
	const boundary = { ...finished, bash: { ...finished.bash, command: "npm test" } };
	const replaced = [initial[0]!, boundary];
	const result = projectTranscriptTail(replaced, projection).projection;
	assert.deepEqual(result, createTranscriptProjection(replaced));
	assert.deepEqual(result.blocks.map((block) => block.kind), ["tool_group", "bash"]);
});

test("assistant text, turn completion, and expanded Shell details retain grouping boundaries", () => {
	const search: MycliShellTranscriptBlock = {
		id: "search", kind: "bash", bash: { id: "search", command: "rg needle src", status: "success" },
	};
	const complete: MycliShellTranscriptBlock = {
		id: "turn", kind: "turn_completed", turnCompleted: { id: "turn", durationMs: 100 },
	};
	const projected = projectTranscriptBlocks([contextTool("read"), message("update"), search, complete, contextTool("next")]);
	assert.deepEqual(projected.map((block) => block.kind), [
		"tool_group", "assistant_separator", "message", "tool_group", "turn_completed", "tool_group",
	]);
	const expanded = [contextTool("read", { expanded: true }), { ...search, bash: { ...search.bash, expanded: true } }];
	assert.deepEqual(projectTranscriptBlocks(expanded), expanded);
});

test("tail projection falls back to a full projection when the retained boundary changed", () => {
	const initial = [message("one"), message("two"), message("three")];
	const blocks = [message("one", "changed prefix"), message("different-boundary"), message("three")];
	const update = projectTranscriptTail(blocks, createTranscriptProjection(initial));

	assert.equal(update.stablePrefixLength, 0);
	assert.deepEqual(update.projection.blocks, projectTranscriptBlocks(blocks));
});

test("tail projection matches a full projection for a single appended block", () => {
	assertMatchesFullProjection([message("one"), message("two")]);
});

test("assistant separators follow work activity while pure conversation stays unseparated", () => {
	const blocks = [
		message("preamble"),
		contextTool("read-1"),
		contextTool("read-2"),
		message("answer"),
		message("followup"),
		{ id: "user", kind: "message" as const, message: { id: "user", role: "user" as const, text: "next" } },
		message("conversation"),
	];
	const original = structuredClone(blocks);
	const projected = projectTranscriptBlocks(blocks);

	assert.deepEqual(projected.map((block) => block.kind), [
		"message", "tool_group", "assistant_separator", "message", "assistant_separator", "message", "message", "message",
	]);
	assert.equal(projected[2]?.id, "assistant_separator:answer");
	assert.equal(projected[4]?.id, "assistant_separator:followup");
	assert.deepEqual(blocks, original);
});

test("separators wait for assistant text and reset at turn completion", () => {
	const blocks: MycliShellTranscriptBlock[] = [
		fileChange("patch"),
		message("empty", " \n "),
		message("answer"),
		{ id: "completed", kind: "turn_completed", turnCompleted: { id: "completed", durationMs: 10 } },
		message("next"),
	];
	assert.deepEqual(projectTranscriptBlocks(blocks).map((block) => block.kind), [
		"file_change", "message", "assistant_separator", "message", "turn_completed", "message",
	]);
	assert.deepEqual(projectTranscriptBlocks([subagent("hidden"), message("answer")]).map((block) => block.kind), ["message"]);
});

test("separator tail projection matches full projection through empty, streaming, and replaced boundaries", () => {
	let blocks: MycliShellTranscriptBlock[] = [contextTool("read-1")];
	const projection = createTranscriptProjection(blocks);
	const steps: MycliShellTranscriptBlock[][] = [
		[...blocks, subagent("hidden")],
		[...blocks, subagent("hidden"), message("answer", "")],
		[...blocks, subagent("hidden"), message("answer", "first")],
		[...blocks, subagent("hidden"), message("answer", "first\n\nsecond")],
		[...blocks, subagent("hidden"), message("answer", "")],
		[...blocks, subagent("hidden"), contextTool("read-2")],
		[...blocks, subagent("hidden"), contextTool("read-2"), message("answer")],
	];
	for (blocks of steps) {
		const expected = createTranscriptProjection(blocks);
		const update = projectTranscriptTail(blocks, projection);
		assert.deepEqual(update.projection, expected);
	}
});

test("streaming after work retains separator context without rereading stable history", () => {
	const initial = [contextTool("work"), ...Array.from({ length: 10_000 }, (_, index) => message(`answer-${index}`))];
	const previous = createTranscriptProjection(initial);
	const next = initial.with(-1, message("answer-9999", "updated"));
	const expected = createTranscriptProjection(next);
	let indexedReads = 0;
	const counted = new Proxy(next, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) indexedReads += 1;
			return Reflect.get(target, property, receiver);
		},
	});
	const update = projectTranscriptTail(counted, previous);

	assert.deepEqual(update.projection, expected);
	assert.equal(update.projection.blocks.at(-2)?.kind, "assistant_separator");
	assert.equal(update.stablePrefixLength, expected.blocks.length - 2);
	assert.ok(indexedReads <= 5, `expected bounded tail reads, received ${indexedReads}`);
});

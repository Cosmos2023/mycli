import assert from "node:assert/strict";
import test from "node:test";
import type { MycliShellTranscriptBlock } from "../src/model.ts";
import {
	createTranscriptProjection,
	projectTranscriptBlocks,
	projectTranscriptTail,
} from "../src/transcript-projection.ts";

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
		"tool",
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
	assert.deepEqual(appendUpdate.projection.blocks.map((block) => block.kind), ["tool", "tool"]);

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

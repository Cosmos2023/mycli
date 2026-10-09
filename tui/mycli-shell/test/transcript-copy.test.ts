import assert from "node:assert/strict";
import test from "node:test";
import type { MycliShellState } from "../src/model.ts";
import { transcriptCopyBlocks, transcriptCopyIndexHint, transcriptCopyText } from "../src/state/transcript-copy.ts";

function state(partial: Partial<MycliShellState>): MycliShellState {
	return { messages: [], tools: [], bash: [], footer: {}, ...partial } as unknown as MycliShellState;
}

test("copy blocks index newest first and keep the Markdown source", () => {
	const blocks = transcriptCopyBlocks(state({
		messages: [
			{ id: "u1", role: "user", text: "show me a table" },
			{ id: "a1", role: "assistant", text: "| a | b |\n| --- | --- |\n| 1 | 2 |" },
			{ id: "s1", role: "system", text: "   " },
			{ id: "a2", role: "assistant", text: "second answer" },
		],
	}));

	assert.deepEqual(blocks.map((block) => [block.index, block.kind, block.label]), [
		[3, "user", "user"],
		[2, "assistant", "assistant"],
		[1, "assistant", "assistant"],
	]);
	// The stored source survives, so a copied table stays a table.
	assert.equal(blocks[1]?.text, "| a | b |\n| --- | --- |\n| 1 | 2 |");
	assert.equal(transcriptCopyIndexHint(blocks), "3=user, 2=assistant, 1=assistant");
	assert.equal(transcriptCopyIndexHint([]), "Nothing copyable yet.");
});

test("copy blocks follow transcript order and include tool receipts", () => {
	const blocks = transcriptCopyBlocks(state({
		transcript: [
			{ id: "u1", kind: "message", message: { id: "u1", role: "user", text: "run it" } },
			{ id: "t1", kind: "tool", tool: { id: "t1", name: "Shell", status: "success", outputPreview: "done\n" } },
			{ id: "a1", kind: "message", message: { id: "a1", role: "assistant", text: "finished" } },
		],
	}));

	assert.deepEqual(blocks.map((block) => block.label), ["user", "Shell (success)", "assistant"]);
	assert.equal(blocks[1]?.text, "Shell\ndone\n");
	assert.equal(blocks[0]?.index, 3);
});

test("whole-conversation copy keeps user and assistant turns only", () => {
	const text = transcriptCopyText(state({
		messages: [
			{ id: "u1", role: "user", text: "question" },
			{ id: "a1", role: "assistant", text: "answer" },
			{ id: "s1", role: "system", text: "notice" },
			{ id: "e1", role: "error", text: "failure" },
		],
	}));

	assert.equal(text, "## User\nquestion\n\n## Assistant\nanswer");
	assert.equal(transcriptCopyText(state({ messages: [{ id: "s1", role: "system", text: "notice" }] })), "");
});

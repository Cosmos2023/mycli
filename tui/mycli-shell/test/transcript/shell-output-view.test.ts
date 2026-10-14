import assert from "node:assert/strict";
import test from "node:test";
import {
	loadShellOutputView,
	shellOutputViewHasMore,
	shellOutputViewRemaining,
	type MycliShellShellOutputPage,
} from "../../src/transcript/shell-output-view.ts";

test("a view reads forward until the store runs out of chunks", async () => {
	const requested: number[] = [];
	const pages: MycliShellShellOutputPage[] = [
		page([{ sequence: 1, output: "a".repeat(10), cursorEnd: 10 }], 1, 30),
		page([{ sequence: 2, output: "b".repeat(10), cursorEnd: 20 }], 2, 30),
		page([{ sequence: 3, output: "c".repeat(10), cursorEnd: 30 }], null, 30),
	];
	const view = await loadShellOutputView({
		shellId: "shell-a",
		load: async (request) => {
			requested.push(request.afterSequence ?? 0);
			return pages[requested.length - 1]!;
		},
	});

	assert.deepEqual(requested, [0, 1, 2]);
	assert.equal(view.text, "a".repeat(10) + "b".repeat(10) + "c".repeat(10));
	assert.equal(view.nextAfterSequence, null);
	assert.equal(view.cursor, 30);
	assert.equal(view.outputChars, 30);
	assert.equal(shellOutputViewHasMore(view, 30), false);
});

test("the row budget stops paging and reports how much the store still holds", async () => {
	let calls = 0;
	const view = await loadShellOutputView({
		shellId: "shell-a",
		maxChars: 15,
		load: async () => {
			calls += 1;
			return page([{ sequence: calls, output: "x".repeat(10), cursorEnd: calls * 10 }], calls, 100);
		},
	});

	assert.equal(calls, 2);
	assert.equal(view.loadedChars, 20);
	assert.equal(view.nextAfterSequence, 2);
	assert.equal(shellOutputViewHasMore(view, 20), true);
	assert.equal(shellOutputViewRemaining(view, 20), 80);
});

test("the first chunk records the characters the store no longer holds", async () => {
	const view = await loadShellOutputView({
		shellId: "shell-a",
		load: async () => page(
			[{ sequence: 9, output: "later\n", omittedBefore: 1_234, cursorEnd: 1_300 }],
			null,
			1_300,
		),
	});

	assert.equal(view.omittedBefore, 1_234);
	assert.equal(view.omittedInside, 0);
	// The head omission is reported by the row, not spliced into the text.
	assert.equal(view.text, "later\n");
});

test("appending continues from the cursor and marks gaps inside the text", async () => {
	const first = await loadShellOutputView({
		shellId: "shell-a",
		load: async () => page([{ sequence: 1, output: "head\n", cursorEnd: 5 }], 1, 40),
	});
	const view = await loadShellOutputView({
		shellId: "shell-a",
		previous: first,
		load: async (request) => {
			assert.equal(request.afterSequence, 1);
			return page([{ sequence: 2, output: "tail\n", omittedBefore: 7, cursorEnd: 40 }], null, 40);
		},
	});

	assert.equal(view.text, "head\n\n… 7 chars omitted …\ntail\n");
	assert.equal(view.omittedInside, 7);
	assert.equal(view.omittedBefore, 0);
	assert.equal(view.cursor, 40);
	assert.equal(shellOutputViewHasMore(view, 40), false);
});

test("a live shell that produced more after the load still reports more", async () => {
	const view = await loadShellOutputView({
		shellId: "shell-a",
		load: async () => page([{ sequence: 1, output: "so far\n", cursorEnd: 7 }], null, 7),
	});

	assert.equal(shellOutputViewHasMore(view, 7), false);
	assert.equal(shellOutputViewHasMore(view, 20), true);
	assert.equal(shellOutputViewRemaining(view, 20), 13);
});

function page(
	chunks: readonly {
		readonly sequence: number;
		readonly output: string;
		readonly omittedBefore?: number;
		readonly cursorEnd: number;
	}[],
	nextAfterSequence: number | null,
	outputChars: number,
): MycliShellShellOutputPage {
	return {
		chunks: chunks.map((chunk) => ({
			sequence: chunk.sequence,
			output: chunk.output,
			omittedBefore: chunk.omittedBefore ?? 0,
			cursorEnd: chunk.cursorEnd,
		})),
		nextAfterSequence,
		outputChars,
	};
}

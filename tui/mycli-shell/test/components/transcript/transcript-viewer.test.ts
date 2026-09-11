import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptViewerComponent } from "../../../src/components/transcript/transcript-viewer.ts";
import type { MycliShellTranscriptBlock } from "../../../src/model.ts";
import { visibleWidth } from "../../../src/tui-core/utils.ts";
import {
	renderTranscriptBlocks,
} from "../../../src/components/transcript/transcript-renderer.ts";

test("full transcript expands retained tool details and context groups without changing the main view", () => {
	const blocks: MycliShellTranscriptBlock[] = [1, 2].map((index) => ({
		id: `read-${index}`, kind: "tool", tool: {
			id: `read-${index}`, name: "Read", args: `file-${index}.txt`, status: "success",
			expanded: false, presentation: "context",
			outputPreview: Array.from({ length: 15 }, (_, line) => `file-${index} line-${line + 1}`).join("\n"),
		},
	}));
	const mainBefore = renderTranscriptBlocks(blocks, 80);
	const viewer = new TranscriptViewerComponent({ blocks, rows: () => 60, onClose: () => {} });
	const text = stripAnsi(viewer.render(80).join("\n"));
	for (const file of [1, 2]) {
		for (let line = 1; line <= 15; line++) assert.ok(text.includes(`file-${file} line-${line}`));
	}
	assert.doesNotMatch(text, /to expand|more lines/u);
	assert.deepEqual(renderTranscriptBlocks(blocks, 80), mainBefore);
});

test("full transcript preserves every read and Shell result hidden by exploration summaries", () => {
	const blocks: MycliShellTranscriptBlock[] = [
		{ id: "first", kind: "tool", tool: {
			id: "first", name: "Read", args: "src/app.ts", status: "success",
			summaryPreview: "Lines 1-10 of 20", outputPreview: "first excerpt",
		} },
		{ id: "second", kind: "tool", tool: {
			id: "second", name: "Read", args: "src/app.ts", status: "success",
			summaryPreview: "Lines 11-20 of 20", outputPreview: "second excerpt",
		} },
		{ id: "search", kind: "bash", bash: {
			id: "search", command: "rg -n -g '*.ts' needle src", status: "success", outputPreview: "src/app.ts:12: needle",
		} },
		{ id: "failed", kind: "bash", bash: {
			id: "failed", command: "rg needle missing", status: "error", exitCode: 2, outputPreview: "missing: No such file or directory",
		} },
	];
	const original = structuredClone(blocks);
	const mainBefore = renderTranscriptBlocks(blocks, 100);
	const summary = stripAnsi(mainBefore.join("\n"));
	assert.match(summary, /Explored.*1 failed/u);
	assert.equal(summary.match(/Read app\.ts/gu)?.length, 1);
	assert.match(summary, /Search needle in missing \(failed\)/u);
	assert.doesNotMatch(summary, /excerpt|Lines 1|--glob|\*\.ts|No such file/u);
	const viewer = new TranscriptViewerComponent({ blocks, rows: () => 60, onClose: () => {} });
	const details = stripAnsi(viewer.render(100).join("\n"));
	assert.match(details, /Lines 1-10 of 20/u);
	assert.match(details, /Lines 11-20 of 20/u);
	assert.match(details, /first excerpt/u);
	assert.match(details, /second excerpt/u);
	assert.match(details, /rg -n -g '\*\.ts' needle src/u);
	assert.match(details, /src\/app\.ts:12: needle/u);
	assert.match(details, /exit 2/u);
	assert.match(details, /missing: No such file or directory/u);
	assert.deepEqual(blocks, original);
	assert.deepEqual(renderTranscriptBlocks(blocks, 100), mainBefore);
});

test("transcript viewer supports line, page, and boundary navigation", () => {
	let rows = 8;
	const viewer = new TranscriptViewerComponent({
		blocks: messageBlocks(24),
		rows: () => rows,
		onClose: () => {},
	});
	viewer.render(60);

	viewer.handleInput("\x1b[A");
	viewer.render(60);
	assert.equal(viewer.getScrollOffset(), 1);
	viewer.handleInput("\x1b[5~");
	viewer.render(60);
	assert.ok(viewer.getScrollOffset() > 1);
	viewer.handleInput("\x1b[H");
	viewer.render(60);
	const topOffset = viewer.getScrollOffset();
	assert.ok(topOffset > 1);
	viewer.handleInput("G");
	viewer.render(60);
	assert.equal(viewer.getScrollOffset(), 0);
	viewer.handleInput("g");
	viewer.render(60);
	assert.equal(viewer.getScrollOffset(), topOffset);
	viewer.handleInput("\x1b[F");
	viewer.render(60);
	assert.equal(viewer.getScrollOffset(), 0);

	rows = 5;
	const narrow = viewer.render(22);
	assert.equal(narrow.length, rows);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 21));
});

test("transcript viewer follows live tail until the user scrolls away", () => {
	const viewer = new TranscriptViewerComponent({
		blocks: messageBlocks(8),
		rows: () => 7,
		onClose: () => {},
	});
	viewer.render(50);
	viewer.updateBlocks([...messageBlocks(8), messageBlock(8, "live-tail-one")]);
	let output = stripAnsi(viewer.render(50).join("\n"));
	assert.match(output, /live-tail-one/u);
	assert.equal(viewer.getScrollOffset(), 0);

	viewer.handleInput("\x1b[5~");
	viewer.render(50);
	assert.ok(viewer.getScrollOffset() > 0);
	viewer.updateBlocks([...messageBlocks(9), messageBlock(9, "live-tail-two")]);
	output = stripAnsi(viewer.render(50).join("\n"));
	assert.doesNotMatch(output, /live-tail-two/u);
	assert.ok(viewer.getScrollOffset() > 0);

	viewer.render(28);
	assert.ok(viewer.getScrollOffset() > 0, "resize unexpectedly resumed tail following");
	viewer.handleInput("G");
	output = stripAnsi(viewer.render(28).join("\n"));
	assert.match(output, /live-tail-two/u);
});

test("transcript viewer requests older history once at the top", () => {
	let loadCount = 0;
	const viewer = new TranscriptViewerComponent({
		blocks: messageBlocks(12),
		rows: () => 7,
		hasOlderHistory: true,
		onLoadOlder: () => { loadCount += 1; },
		onClose: () => {},
	});
	viewer.render(50);

	viewer.handleInput("g");
	viewer.render(50);
	assert.equal(loadCount, 1);

	viewer.setOlderHistoryState({ available: true, loading: true });
	viewer.handleInput("g");
	viewer.handleInput("\x1b[A");
	assert.equal(loadCount, 1);
});

test("transcript viewer preserves visible lines when older blocks are prepended", () => {
	const original = messageBlocks(12);
	const viewer = new TranscriptViewerComponent({
		blocks: original,
		rows: () => 7,
		onClose: () => {},
	});
	viewer.render(50);
	viewer.handleInput("\x1b[5~");
	const before = stripAnsi(viewer.render(50).join("\n"));

	viewer.updateBlocks([
		messageBlock(-2, "older-two"),
		messageBlock(-1, "older-one"),
		...original,
	], { preserveScrollOffset: true });
	const after = stripAnsi(viewer.render(50).join("\n"));

	assert.equal(contentRows(after), contentRows(before));
	assert.doesNotMatch(after, /older-(?:one|two)/u);
});

test("transcript viewer expands retained Shell output with a truncation notice", () => {
	const bash = {
		id: "legacy-shell",
		command: "legacy command",
		status: "success" as const,
		shellId: "legacy-shell-id",
		callId: "legacy-call-id",
		outputPreview: "saved tail",
		omittedOutputChars: 200,
	};
	const viewer = new TranscriptViewerComponent({
		blocks: [{ id: bash.id, kind: "bash", bash }],
		rows: () => 12,
		onClose: () => {},
	});
	const output = stripAnsi(viewer.render(80).join("\n"));
	assert.match(output, /Output truncated. Showing retained output/u);
	assert.match(output, /saved tail/u);
});

test("transcript viewer closes with escape, q and Ctrl+C", () => {
	let closeCount = 0;
	const viewer = new TranscriptViewerComponent({
		blocks: [],
		rows: () => 6,
		onClose: () => { closeCount += 1; },
	});

	viewer.handleInput("\x1b");
	viewer.handleInput("q");
	viewer.handleInput("\x03");
	assert.equal(closeCount, 3);
});

function messageBlocks(count: number): MycliShellTranscriptBlock[] {
	return Array.from({ length: count }, (_, index) => messageBlock(index, `message-${index}`));
}

function messageBlock(index: number, text: string): MycliShellTranscriptBlock {
	return {
		id: `message-${index}`,
		kind: "message",
		message: { id: `message-${index}`, role: index % 2 === 0 ? "user" : "assistant", text },
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, "");
}

function contentRows(frame: string): string {
	return frame.split("\n").slice(1, -1).join("\n");
}

import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptViewerComponent } from "../src/components/transcript-viewer.ts";
import type { MycliShellTranscriptBlock } from "../src/model.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";

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

test("transcript viewer marks legacy Shell output as unavailable", () => {
	const bash = {
		id: "legacy-shell",
		command: "legacy command",
		status: "success" as const,
		shellId: "legacy-shell-id",
		callId: "legacy-call-id",
		outputPreview: "saved tail",
	};
	const viewer = new TranscriptViewerComponent({
		blocks: [{ id: bash.id, kind: "bash", bash }],
		rows: () => 12,
		onClose: () => {},
	});
	viewer.setShellOutput({
		sessionId: "legacy-session",
		shellId: bash.shellId,
		callId: bash.callId,
		output: "",
		available: false,
		complete: false,
		omittedChars: 0,
		capturedChars: 0,
		outputChars: 0,
	});

	const output = stripAnsi(viewer.render(80).join("\n"));
	assert.match(output, /Full output was not retained for this older session/u);
	assert.match(output, /saved tail/u);
});

test("transcript viewer closes with escape and q", () => {
	let closeCount = 0;
	const viewer = new TranscriptViewerComponent({
		blocks: [],
		rows: () => 6,
		onClose: () => { closeCount += 1; },
	});

	viewer.handleInput("\x1b");
	viewer.handleInput("q");
	assert.equal(closeCount, 2);
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

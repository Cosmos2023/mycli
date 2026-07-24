import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent } from "../src/components/assistant-message.ts";
import {
	renderTranscriptMessageLines,
	transcriptMessageContentWidth,
} from "../src/components/transcript-message-layout.ts";
import { UserMessageComponent } from "../src/components/user-message.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

function visibleContentLines(lines: string[]): string[] {
	return lines.map(stripAnsi).filter((line) => line.trim().length > 0);
}

test("transcript message layout applies a role marker and hanging indent", () => {
	const lines = renderTranscriptMessageLines(["alpha", "beta"], 10, "› ");

	assert.equal(lines[0]?.trimEnd(), "› alpha");
	assert.equal(lines[1]?.trimEnd(), "  beta");
	assert.equal(lines.every((line) => visibleWidth(line) === 10), true);
});

test("transcript message layout reserves exactly two terminal cells", () => {
	assert.equal(transcriptMessageContentWidth(80), 78);
	assert.equal(transcriptMessageContentWidth(2), 1);
	assert.equal(transcriptMessageContentWidth(1), 1);
});

test("user and assistant messages render Codex-style role prefixes", () => {
	const user = visibleContentLines(new UserMessageComponent("不是mycli的问题").render(40));
	const assistant = visibleContentLines(
		new AssistantMessageComponent("对，这次不是 mycli 的问题。").render(40),
	);

	assert.equal(user[0]?.startsWith("› "), true);
	assert.equal(assistant[0]?.startsWith("• "), true);
});

test("wrapped CJK transcript lines use a two-cell hanging indent", () => {
	const lines = visibleContentLines(
		new AssistantMessageComponent("第三轮到第四轮请求保持严格追加，缓存键和工具定义都没有变化。").render(18),
	);

	assert.equal(lines.length > 1, true);
	assert.equal(lines[0]?.startsWith("• "), true);
	assert.equal(lines.slice(1).every((line) => line.startsWith("  ")), true);
	assert.equal(lines.every((line) => visibleWidth(line) <= 18), true);
});

test("Markdown indentation remains inside the transcript hanging indent", () => {
	const lines = visibleContentLines(
		new AssistantMessageComponent("- first item with enough text to wrap onto another line").render(24),
	);

	assert.equal(lines[0]?.startsWith("• "), true);
	assert.equal(lines.slice(1).every((line) => line.startsWith("  ")), true);
});

test("assistant message updates retain the role prefix", () => {
	const component = new AssistantMessageComponent("partial");
	component.updateMessage("complete response");
	const lines = visibleContentLines(component.render(30));

	assert.equal(lines[0]?.startsWith("• complete response"), true);
});

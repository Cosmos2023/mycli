import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

function renderColoredUserMessage(): string[] {
	const fixture = fileURLToPath(new URL("./fixtures/render-user-message-theme.ts", import.meta.url));
	const env = { ...process.env };
	delete env.NO_COLOR;
	const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
		encoding: "utf8",
		env: {
			...env,
			MYCLI_TUI_COLOR: "always",
			COLORTERM: "truecolor",
		},
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.split("\n");
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

test("a completed assistant answer leaves two rows before the next user input", () => {
	const lines = [
		...new AssistantMessageComponent("上一轮回答最后一行").render(40),
		...new UserMessageComponent("下一轮输入").render(40),
	].map(stripAnsi);
	const assistantLine = lines.findIndex((line) => line.includes("上一轮回答最后一行"));
	const userLine = lines.findIndex((line) => line.includes("下一轮输入"));

	assert.equal(userLine - assistantLine, 3);
});

test("user message keeps a full-width background behind its Codex-style prefix", () => {
	const lines = renderColoredUserMessage();
	const backgroundPattern = /\x1b\[48;2;52;53;65m/;

	assert.equal(lines.length > 3, true);
	assert.equal(backgroundPattern.test(lines[0] ?? ""), false);
	assert.equal(lines.slice(1).every((line) => backgroundPattern.test(line)), true);
	assert.equal(lines.every((line) => visibleWidth(line) === 18), true);
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

test("assistant tail rendering matches slicing full visible and thinking output", () => {
	for (const component of [
		new AssistantMessageComponent("First paragraph.\n\nSecond paragraph with enough text to wrap across rows."),
		new AssistantMessageComponent("Final answer", "Reasoning line one.\n\nReasoning line two.", false),
	]) {
		const full = component.render(32);
		for (const maxRows of [0, 1, 3, full.length - 1, full.length, full.length + 2]) {
			const tail = component.renderTail(32, maxRows);
			assert.equal(tail.totalLines, full.length);
			assert.deepEqual(tail.lines, maxRows === 0 ? [] : full.slice(-maxRows));
		}
	}
});

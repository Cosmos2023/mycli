import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent } from "../src/components/transcript/assistant-message.ts";
import type { MycliShellState } from "../src/model.ts";
import {
	MycliShellRuntime,
} from "../src/application/shell-runtime.ts";
import { visibleWidth, wrapTextWithAnsi } from "../src/tui-core/utils.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

const SAMPLE = "当前状态已经明确：功能分支上的 ScreenCapture 计划共 7 个任务，前 6 个都已提交；第 7 个代码已写好并通过自动化验证，但兼容性文档和最终提交仍在等待五分钟人工稳定性门禁。我再核对该分支相对 main 的整体改动规模，随后给你完整进度和下一步。";
const EXPECTED_AT_80 = [
	"• 当前状态已经明确：功能分支上的 ScreenCapture 计划共 7 个任务，前 6 个都已提",
	"  交；第 7 个代码已写好并通过自动化验证，但兼容性文档和最终提交仍在等待五分钟人",
	"  工稳定性门禁。我再核对该分支相对 main 的整体改动规模，随后给你完整进度和下一",
	"  步。",
];

function messageLines(component: AssistantMessageComponent, width: number): string[] {
	return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).filter(Boolean);
}

function assertVisibleMessage(terminal: HeadlessTerminal, text: string): void {
	const screen = terminal.visibleLines().map((line) => line.trimEnd());
	const expected = messageLines(new AssistantMessageComponent(text), terminal.columns);
	const start = screen.findIndex((line) => line.includes("当前状态"));
	assert.ok(start >= 0, `missing response at width ${terminal.columns}`);
	assert.deepEqual(screen.slice(start, start + expected.length), expected);
	assert.ok(screen.some((line) => line.includes("WRAP CHECK")));
}

test("mixed Chinese progress prose fills available rows during streaming and resize", () => {
	for (const initialWidth of [60, 80, 100, 120]) {
		const component = new AssistantMessageComponent("");
		let partial = "";
		for (const character of SAMPLE) {
			partial += character;
			component.updateMessage(partial);
			assert.deepEqual(component.render(initialWidth), new AssistantMessageComponent(partial).render(initialWidth));
		}
		for (const width of [initialWidth, 60, 120, 80, 100]) {
			const lines = messageLines(component, width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.slice(0, -1).every((line) => width - visibleWidth(line) <= 3));
			assert.equal(lines.map((line) => line.slice(2)).join("").replace(/\s/gu, ""), SAMPLE.replace(/\s/gu, ""));
			assert.deepEqual(component.renderTail(width, 3).lines, component.render(width).slice(-3));
			if (width === 80) assert.deepEqual(lines, EXPECTED_AT_80);
		}
	}
});

for (const nativeScrollback of [false, true]) {
	test(`Chinese streaming and resize leave correct terminal cells (native=${nativeScrollback})`, async (t) => {
		const terminal = new HeadlessTerminal({ columns: 80, rows: 24, nativeScrollback });
		const initialState: MycliShellState = {
			messages: [{ id: "user", role: "user", text: "WRAP CHECK" }],
			tools: [], bash: [], footer: { cwd: "/workspace", model: "test", liveState: "Working" },
		};
		const runtime = new MycliShellRuntime({ initialState, terminal });
		t.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
		runtime.start();
		for (let end = 8; end < SAMPLE.length; end += 17) {
			runtime.setState({ ...initialState, messages: [...initialState.messages,
				{ id: "assistant", role: "assistant", text: SAMPLE.slice(0, end) }],
			});
			await delay(25);
			await terminal.flush();
			assertVisibleMessage(terminal, SAMPLE.slice(0, end));
		}
		runtime.setState({ ...initialState, messages: [...initialState.messages,
			{ id: "assistant", role: "assistant", text: SAMPLE }],
		});
		await delay(25);
		await terminal.flush();
		assertVisibleMessage(terminal, SAMPLE);
		for (const width of [80, 60, 120, 100, 80]) {
			terminal.resize(width, 24);
			// Native resize rebuilds from source after the 75 ms debounce.
			await delay(120);
			await terminal.flush();
			assertVisibleMessage(terminal, SAMPLE);
		}
	});
}

test("wrapping Chinese text preserves foreground colors in physical terminal cells", async (t) => {
	const terminal = new HeadlessTerminal({ columns: 10, rows: 4 });
	t.after(() => terminal.dispose());
	const lines = wrapTextWithAnsi("abc \x1b[31m中文连续文本内容\x1b[0m", 10);
	terminal.write(lines.join("\r\n"));
	await terminal.flush();
	assert.deepEqual(terminal.visibleLines().slice(0, 2), ["abc 中文连", "续文本内容"]);
	for (const column of [4, 6, 8]) assert.equal(terminal.visibleCell(0, column)?.getFgColor(), 1);
	for (const column of [0, 2, 4, 6, 8]) assert.equal(terminal.visibleCell(1, column)?.getFgColor(), 1);
	assert.ok(terminal.visibleCell(0, 0)?.isFgDefault());
});

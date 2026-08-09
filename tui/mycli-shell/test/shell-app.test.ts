import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Terminal } from "../src/tui-core/terminal.ts";
import { Editor } from "../src/tui-core/components/editor.ts";
import { Text } from "../src/tui-core/components/text.ts";
import { TUI, visibleWidth } from "../src/tui-core/tui.ts";
import { spawnSync } from "node:child_process";
import { BashExecutionComponent, FileChangeComponent, FooterComponent, MycliShellRuntime, PendingInputPreviewComponent, renderMycliShell, ToolExecutionComponent, TrustSelectorComponent, type MycliShellCommandSpec, type MycliShellState } from "../src/index.ts";
import { filterSessions, parseSessionSearchQuery } from "../src/components/session-selector-search.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

function assertNativeScrollbackSafeOutput(output: string): void {
	assert.doesNotMatch(output, /\x1b\[\?1049[hl]/);
	assert.doesNotMatch(output, /\x1b\[\?(1000|1002|1003|1006)h/);
	assert.doesNotMatch(output, /\x1b\[2J/);
	assert.doesNotMatch(output, /\x1b\[3J/);
}

function sampleState(): MycliShellState {
	return {
		title: "mycli",
		messages: [
			{ id: "u1", role: "user", text: "Read `word.txt` and summarize it." },
			{ id: "a1", role: "assistant", thinking: "I should inspect the file", thinkingHidden: true, text: "**Summary:** hello." },
		],
		tools: [
			{ id: "t1", name: "Read", args: "word.txt", status: "success", outputPreview: "15 lines", durationMs: 35 },
			{ id: "t2", name: "Edit", args: "src/app.py", status: "error", errorPreview: "Patch did not apply", mutating: true },
		],
		bash: [
			{ id: "b1", command: "pytest -q", status: "error", exitCode: 1, outputPreview: "1 failed", hiddenLineCount: 42 },
		],
		footer: {
			cwd: "~/Desktop/mycli",
			gitBranch: "feature/tui",
			sessionName: "demo",
			provider: "deepseek",
			model: "deepseek-v4-flash",
			reasoningLevel: "medium",
			contextPercent: 42.5,
			contextWindow: 128000,
			totalInputTokens: 1200,
			totalOutputTokens: 700,
			cacheReadTokens: 300,
			autoCompact: true,
			trust: "trusted",
			liveState: "Idle",
			extensionStatuses: ["terminal ready"],
		},
		currentModel: {
			provider: "deepseek",
			model: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			scoped: true,
		},
		models: [
			{
				provider: "deepseek",
				protocol: "chat_completions",
				model: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				baseUrl: "https://api.deepseek.com",
				supportedReasoningEfforts: [],
				current: true,
			},
			{
				provider: "openai",
				protocol: "responses",
				model: "gpt-5.4",
				name: "GPT 5.4",
				baseUrl: "https://api.openai.com/v1",
				supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
				defaultReasoningEffort: "medium",
			},
		],
		settings: {
			statusbarMode: "full",
			viewMode: "default",
			theme: "dark",
			hideThinking: true,
		},
		sessions: [
			{
				id: "session-a",
				title: "Session A",
				cwd: "~/Desktop/mycli",
				modified: "2026-06-18T10:00:00Z",
				firstMessage: "Fix session selector",
				allMessagesText: "Fix session selector in mycli shell",
				messageCount: 3,
				named: true,
			},
			{
				id: "session-b",
				title: "Session B",
				cwd: "~/Desktop/other",
				modified: "2026-06-18T09:00:00Z",
				firstMessage: "Investigate cache hits",
				allMessagesText: "Investigate cache hits with response API",
				messageCount: 4,
			},
		],
		resources: [
			{
				id: "hook:1",
				type: "hook",
				name: "configured:repo:post-tool",
				source: "repo",
				enabled: true,
				status: "enabled",
				detail: "configured hook",
				command: "/tools hooks",
			},
		],
		pendingNotice: "Waiting for approval",
	};
}

function expandedToolDetailState(): MycliShellState {
	const tool = {
		id: "tool-detail",
		name: "Read",
		args: "README.md",
		status: "success" as const,
		outputPreview: "line one\nline two",
		hiddenLineCount: 1,
		expanded: true,
	};
	const bash = {
		id: "shell-detail",
		toolName: "Shell",
		command: "printf 'one\\ntwo\\n'",
		status: "success" as const,
		outputPreview: "one\ntwo",
		expanded: true,
	};
	return {
		...sampleState(),
		messages: [],
		tools: [tool],
		bash: [bash],
		transcript: [
			{ id: tool.id, kind: "tool", tool },
			{ id: bash.id, kind: "bash", bash },
		],
		pendingNotice: undefined,
	};
}

function slashCommand(
	id: string,
	name: string,
	description: string,
): MycliShellCommandSpec {
	return {
		id,
		name,
		description,
		argumentPolicy: "none",
		availableDuringTurn: true,
	};
}

test("session selector search supports phrase regex scope sort and named filters", () => {
	const sessions = sampleState().sessions ?? [];

	assert.deepEqual(parseSessionSearchQuery('Session "cache hits"').tokens, [
		{ kind: "fuzzy", value: "Session" },
		{ kind: "phrase", value: "cache hits" },
	]);
	assert.equal(parseSessionSearchQuery("re:[").error !== undefined, true);
	assert.deepEqual(
		filterSessions(sessions, {
			query: '"cache hits"',
			scope: "all",
			sortMode: "relevance",
			nameFilter: "all",
			currentWorkspace: "~/Desktop/mycli",
		}).map((session) => session.id),
		["session-b"],
	);
	assert.deepEqual(
		filterSessions(sessions, {
			query: "",
			scope: "current",
			sortMode: "recent",
			nameFilter: "named",
			currentWorkspace: "~/Desktop/mycli",
		}).map((session) => session.id),
		["session-a"],
	);
});

function subagentPanelState(): MycliShellState {
	return {
		...sampleState(),
		transcript: [
			{
				id: "subagent-a1",
				kind: "subagent",
				subagent: {
					id: "subagent-a1",
					role: "explore",
					description: "Inspect auth bug",
					status: "running",
					mode: "sync",
					childSessionId: "child-session-1",
					parentTurnId: "turn-1",
					toolCalls: 2,
					tokens: 18232,
					durationMs: 12000,
					summary: "Read src/auth/session.py",
					progress: [
						{ kind: "tool_call", toolName: "Read", summary: "Read path=src/auth/session.py" },
						{ kind: "tool_result", toolName: "Read", summary: "Found token refresh logic" },
					],
				},
			},
			{
				id: "subagent-a2",
				kind: "subagent",
				subagent: {
					id: "subagent-a2",
					role: "review",
					description: "Research tests",
					status: "completed",
					mode: "sync",
					childSessionId: "child-session-2",
					parentTurnId: "turn-1",
					toolCalls: 1,
					tokens: 9120,
					durationMs: 31000,
					summary: "Done",
				},
			},
		],
		pendingNotice: undefined,
	};
}

class TestTerminal implements Terminal {
	columns = 100;
	rows = 40;
	kittyProtocolActive = false;
	nativeScrollback = false;
	alternateScreen = false;
	output = "";
	input?: (data: string) => void;
	resize?: () => void;
	started = false;
	stopped = false;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.input = onInput;
		this.resize = onResize;
		this.started = true;
	}

	stop(): void {
		this.stopped = true;
		this.started = false;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.output += data;
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	fullClearCount(): number {
		return (this.output.match(/\x1b\[2J/g) ?? []).length;
	}
}

class ScrollbackTerminal extends TestTerminal {
	private screen: string[];
	private cursorRow = 0;
	private cursorColumn = 0;
	readonly scrollback: string[] = [];

	constructor() {
		super();
		this.screen = Array.from({ length: this.rows }, () => "");
	}

	override write(data: string): void {
		super.write(data);
		this.resizeScreen();
		for (let index = 0; index < data.length;) {
			const char = data[index]!;
			if (char === "\x1b") {
				const consumed = this.applyEscape(data.slice(index));
				index += Math.max(1, consumed);
				continue;
			}
			if (char === "\r") {
				this.cursorColumn = 0;
				index += 1;
				continue;
			}
			if (char === "\n") {
				this.lineFeed();
				index += 1;
				continue;
			}
			const codePoint = data.codePointAt(index)!;
			const text = String.fromCodePoint(codePoint);
			this.writeText(text);
			index += text.length;
		}
	}

	visibleLines(): string[] {
		return [...this.screen];
	}

	physicalLines(): string[] {
		return [...this.scrollback, ...this.screen];
	}

	private resizeScreen(): void {
		while (this.screen.length < this.rows) this.screen.push("");
		if (this.screen.length > this.rows) {
			this.scrollback.push(...this.screen.splice(0, this.screen.length - this.rows));
		}
		this.cursorRow = Math.min(this.cursorRow, Math.max(0, this.rows - 1));
	}

	private applyEscape(data: string): number {
		const csi = data.match(/^\x1b\[([?\d;]*)([A-Za-z@`~])/);
		if (csi) {
			const params = csi[1]!.replace(/^\?/, "").split(";").filter(Boolean).map(Number);
			const amount = Math.max(1, params[0] ?? 1);
			switch (csi[2]) {
				case "A":
					this.cursorRow = Math.max(0, this.cursorRow - amount);
					break;
				case "B":
					this.cursorRow = Math.min(this.rows - 1, this.cursorRow + amount);
					break;
				case "G":
					this.cursorColumn = Math.max(0, amount - 1);
					break;
				case "H":
				case "f":
					this.cursorRow = Math.max(0, Math.min(this.rows - 1, (params[0] ?? 1) - 1));
					this.cursorColumn = Math.max(0, (params[1] ?? 1) - 1);
					break;
				case "J":
					this.eraseDisplay(params[0] ?? 0);
					break;
				case "K":
					this.eraseLine(params[0] ?? 0);
					break;
			}
			return csi[0].length;
		}
		const osc = data.match(/^\x1b\][^\x07]*(?:\x07|\x1b\\)/);
		if (osc) return osc[0].length;
		return data.length >= 2 ? 2 : 1;
	}

	private eraseDisplay(mode: number): void {
		if (mode === 2) {
			this.screen.fill("");
			return;
		}
		if (mode === 3) {
			this.scrollback.length = 0;
			return;
		}
		if (mode !== 0) return;
		this.screen[this.cursorRow] = (this.screen[this.cursorRow] ?? "").slice(0, this.cursorColumn);
		for (let row = this.cursorRow + 1; row < this.screen.length; row++) this.screen[row] = "";
	}

	private eraseLine(mode: number): void {
		const line = this.screen[this.cursorRow] ?? "";
		if (mode === 2) {
			this.screen[this.cursorRow] = "";
		} else if (mode === 1) {
			this.screen[this.cursorRow] = " ".repeat(this.cursorColumn + 1) + line.slice(this.cursorColumn + 1);
		} else {
			this.screen[this.cursorRow] = line.slice(0, this.cursorColumn);
		}
	}

	private lineFeed(): void {
		if (this.cursorRow === this.rows - 1) {
			this.scrollback.push(this.screen.shift() ?? "");
			this.screen.push("");
			return;
		}
		this.cursorRow += 1;
	}

	private writeText(text: string): void {
		const line = this.screen[this.cursorRow] ?? "";
		this.screen[this.cursorRow] =
			line.slice(0, this.cursorColumn) + text + line.slice(this.cursorColumn + text.length);
		this.cursorColumn += text.length;
	}
}

class ClosableTerminal extends TestTerminal {
	closed = false;

	override write(data: string): void {
		if (this.closed) {
			throw new Error("write after close");
		}
		super.write(data);
	}

	override showCursor(): void {
		this.write("\x1b[?25h");
	}
}

test("mycli shell renders promoted shell surfaces", () => {
	const output = stripAnsi(renderMycliShell(sampleState(), 100).join("\n"));

	assert.match(output, /mycli/);
	assert.match(output, /Read word\.txt/);
	assert.match(output, /^› Read word\.txt and summarize it\./m);
	assert.doesNotMatch(output, /Thinking\.\.\./);
	assert.doesNotMatch(output, /I should inspect the file/);
	assert.match(output, /Summary: hello/);
	assert.match(output, /^• Summary: hello\./m);
	assert.match(output, /Read/);
	assert.match(output, /Edit/);
	assert.match(output, /Patch did not apply/);
	assert.match(output, /^ • Ran pytest -q/m);
	assert.doesNotMatch(output, /^  • Ran pytest -q/m);
	assert.match(output, /└ exit 1/);
	assert.match(output, /Waiting for approval/);
	assert.match(output, /^~\/Desktop\/mycli/m);
	assert.match(output, /deepseek-v4-flash/);
});

test("mycli shell renders complete assistant code blocks", () => {
	const pythonLines = Array.from({ length: 16 }, (_, index) => `print("line_${String(index + 1).padStart(2, "0")}")`);
	const output = stripAnsi(
		renderMycliShell(
			{
				...sampleState(),
				messages: [
					{
						id: "a-code",
						role: "assistant",
						text: ["Run this:", "```python", ...pythonLines, "```"].join("\n"),
					},
				],
				tools: [],
				bash: [],
				pendingNotice: undefined,
			},
			100,
		).join("\n"),
	);

	assert.match(output, /print\("line_01"\)/);
	assert.match(output, /print\("line_16"\)/);
	assert.doesNotMatch(output, /\.\.\. 8 more lines/);
});

test("mycli shell hides resolved subagent transcript blocks", () => {
	const output = stripAnsi(
		renderMycliShell(
			{
				...sampleState(),
				transcript: [
					{
						id: "subagent-a1",
						kind: "subagent",
						subagent: {
							id: "subagent-a1",
							role: "explore",
							status: "completed",
							mode: "sync",
							childSessionId: "child-session-1",
							toolCalls: 3,
							summary: "Mapped Claude Code worker badge behavior.",
						},
					},
				],
			},
			100,
		).join("\n"),
	);

	assert.doesNotMatch(output, /Agent finished/);
	assert.doesNotMatch(output, /explore · 3 tool uses/);
	assert.doesNotMatch(output, /Done/);
	assert.doesNotMatch(output, /child-session-1/);
	assert.doesNotMatch(output, /Mapped Claude Code worker badge behavior/);
});

test("mycli shell keeps running subagents out of the transcript and exposes tasks entry", () => {
	const output = stripAnsi(
		renderMycliShell(
			subagentPanelState(),
			100,
		).join("\n"),
	);

	assert.doesNotMatch(output, /Running agent/);
	assert.doesNotMatch(output, /explore \(Inspect auth bug\)/);
	assert.doesNotMatch(output, /Read path=src\/auth\/session\.py/);
	assert.doesNotMatch(output, /Found token refresh logic/);
	assert.doesNotMatch(output, /review \(Research tests\)/);
	assert.doesNotMatch(output, /⎿ Done/);
	assert.match(output, /◇ 1 local agent · \/tasks view/);
});

test("mycli shell opens Claude Code-like background subagent dialog from tasks", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: subagentPanelState(),
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	let output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /◇ 1 local agent · \/tasks view/);
	assert.doesNotMatch(output, /Background tasks/);

	await runtime.handleClientAction("open_tasks", "");
	await setTimeout(25);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /explore › Inspect auth bug/);
	assert.match(output, /← go back · Esc\/Enter\/Space close/);
	assert.match(output, /Result/);

	terminal.input?.("\x1b");
	await setTimeout(25);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.doesNotMatch(output, /explore › Inspect auth bug/);
});

test("mycli shell keeps completed background subagents out of the main transcript", () => {
	const output = stripAnsi(
		renderMycliShell(
			{
				...sampleState(),
				transcript: [
					{
						id: "subagent-bg",
						kind: "subagent",
						subagent: {
							id: "subagent-bg",
							role: "explore",
							description: "Inspect repo",
							status: "completed",
							mode: "background",
							childSessionId: "child-session-bg",
							parentTurnId: "turn-2",
							toolCalls: 4,
							summary: "Agent \"Inspect repo\" completed",
						},
					},
				],
				pendingNotice: undefined,
			},
			100,
		).join("\n"),
	);

	assert.doesNotMatch(output, /Agent "Inspect repo" completed/);
	assert.doesNotMatch(output, /Agent finished/);
	assert.doesNotMatch(output, /\/tasks view/);
});

test("mycli shell keeps resolved subagents out of the main transcript even without mode", () => {
	const output = stripAnsi(
		renderMycliShell(
			{
				...sampleState(),
				transcript: [
					{
						id: "subagent-failed",
						kind: "subagent",
						subagent: {
							id: "subagent-failed",
							role: "review",
							description: "Review repo",
							status: "failed",
							childSessionId: "child-session-failed",
							parentTurnId: "turn-2",
							summary: "Agent failed loudly",
						},
					},
				],
				pendingNotice: undefined,
			},
			100,
		).join("\n"),
	);

	assert.doesNotMatch(output, /Agent failed loudly/);
	assert.doesNotMatch(output, /review/);
	assert.doesNotMatch(output, /\/tasks view/);
});

test("mycli shell clears max-turns agents from the active UI", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			transcript: [
				{
					id: "subagent-limited",
					kind: "subagent",
					subagent: {
						id: "subagent-limited",
						role: "explore",
						description: "Explore the tools subsystem",
						status: "max_turns",
						mode: "background",
						childSessionId: "child-session-limited",
						toolCalls: 41,
						summary: "Child sub-agent reached the max turn limit.",
					},
				},
			],
			pendingNotice: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	let output = stripAnsi(runtime.ui.render(100).join("\n"));

	assert.doesNotMatch(output, /Child sub-agent reached the max turn limit\./);
	assert.doesNotMatch(output, /Running agent/);
	assert.doesNotMatch(output, /\/tasks view/);

	await runtime.handleClientAction("open_tasks", "");
	await setTimeout(25);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /No agents in this session/);
	assert.doesNotMatch(output, /Explore the tools subsystem/);
	assert.doesNotMatch(output, /Child sub-agent reached the max turn limit\./);
});

test("mycli shell clears completed background subagents from tasks", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			transcript: [
				{
					id: "subagent-bg",
					kind: "subagent",
					subagent: {
						id: "subagent-bg",
						role: "explore",
						description: "Inspect repo",
						status: "completed",
						mode: "background",
						childSessionId: "child-session-bg",
						parentTurnId: "turn-2",
						toolCalls: 4,
						summary: "Agent completed",
					},
				},
			],
			pendingNotice: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_tasks", "");
	await setTimeout(25);

	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /No agents in this session/);
	assert.doesNotMatch(output, /explore › Inspect repo/);
	assert.doesNotMatch(output, /Agent completed/);
});

test("mycli shell x stops the selected running background subagent", async () => {
	const terminal = new TestTerminal();
	const commands: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			transcript: [
				{
					id: "subagent-bg",
					kind: "subagent",
					subagent: {
						id: "subagent-bg",
						role: "explore",
						description: "Inspect repo",
						status: "running",
						mode: "background",
						childSessionId: "child-session-bg",
						parentTurnId: "turn-2",
						summary: "Reading repository",
					},
				},
			],
			pendingNotice: undefined,
		},
		terminal,
		onCommandSubmit: (command) => {
			commands.push(command);
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_tasks", "");
	await setTimeout(25);
	terminal.input?.("x");
	await setTimeout(25);

	assert.deepEqual(commands, ["/tasks agents kill child-session-bg"]);
	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Stopping @explore \(child-session-bg\)\./);
});

test("mycli shell renders complete Plan updates in transcript order", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		pendingNotice: undefined,
		transcript: [
			{
				id: "plan-1",
				kind: "plan_update",
				planUpdate: {
					id: "plan-1",
					title: "Updated Plan",
					source: "Plan",
					completed: 1,
					total: 3,
					steps: [
						{ id: "inspect", text: "Inspect runtime", status: "completed" },
						{ id: "render", text: "Render Plan history", status: "in_progress" },
						{ id: "verify", text: "Verify resume", status: "pending" },
					],
				},
			},
		],
	};

	const output = stripAnsi(renderMycliShell(state, 72).join("\n"));
	const planIndex = output.indexOf("• Updated Plan");
	const footerIndex = output.indexOf("enter send");

	assert.ok(planIndex >= 0, output);
	assert.ok(footerIndex > planIndex, output);
	assert.match(output, /✔ Inspect runtime/);
	assert.match(output, /□ Render Plan history/);
	assert.match(output, /□ Verify resume/);
	assert.doesNotMatch(output, /\[plan\]/);
});

test("mycli shell renders an empty Plan update in history", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		pendingNotice: undefined,
		transcript: [
			{
				id: "plan-empty",
				kind: "plan_update",
				planUpdate: {
					id: "plan-empty",
					title: "Updated Plan",
					completed: 0,
					total: 0,
					steps: [],
				},
			},
		],
	};

	const output = stripAnsi(renderMycliShell(state, 60).join("\n"));
	assert.match(output, /• Updated Plan/);
	assert.match(output, /\(no steps provided\)/);
});

test("Plan history remains width safe for CJK and long tokens", () => {
	const width = 36;
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		pendingNotice: undefined,
		transcript: [
			{
				id: "plan-wide",
				kind: "plan_update",
				planUpdate: {
					id: "plan-wide",
					title: "Updated Plan",
					completed: 0,
					total: 2,
					steps: [
						{ id: "cjk", text: "检查终端中的中文内容是否能够正确换行", status: "in_progress" },
						{ id: "token", text: "averyveryveryveryveryverylongtoken", status: "pending" },
					],
				},
			},
		],
	};

	const lines = renderMycliShell(state, width);
	assert.match(stripAnsi(lines.join("\n")), /检查终端/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line too wide: ${stripAnsi(line)}`);
	}
});

test("mycli shell renders transcript blocks in event order", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [
			{ id: "u1", role: "user", text: "read word.txt" },
			{ id: "a1", role: "assistant", text: "done" },
		],
		tools: [
			{ id: "t1", name: "Read", args: "word.txt", status: "success" },
		],
		bash: [],
		transcript: [
			{ id: "u1", kind: "message", message: { id: "u1", role: "user", text: "read word.txt" } },
			{ id: "t1", kind: "tool", tool: { id: "t1", name: "Read", args: "word.txt", status: "success" } },
			{ id: "a1", kind: "message", message: { id: "a1", role: "assistant", text: "done" } },
		],
		pendingNotice: undefined,
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));
	const userIndex = output.indexOf("read word.txt");
	const toolIndex = output.indexOf("⏺ Read");
	const assistantIndex = output.lastIndexOf("done");

	assert.ok(userIndex >= 0, output);
	assert.ok(toolIndex > userIndex, output);
	assert.ok(assistantIndex > toolIndex, output);
});

test("mycli shell renders tools marked hidden by legacy session state", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [{ id: "read-legacy", name: "Read", args: "legacy.txt", status: "success", hidden: true }],
		bash: [],
		transcript: [
			{
				id: "read-legacy",
				kind: "tool",
				tool: { id: "read-legacy", name: "Read", args: "legacy.txt", status: "success", hidden: true },
			},
		],
		pendingNotice: undefined,
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));

	assert.match(output, /⏺ Read/);
	assert.match(output, /legacy\.txt/);
});

test("mycli shell renders proposed plans as dedicated blocks", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		transcript: [
			{ id: "u1", kind: "message", message: { id: "u1", role: "user", text: "plan this" } },
			{ id: "a1", kind: "message", message: { id: "a1", role: "assistant", text: "I checked the repo." } },
			{ id: "p1", kind: "plan", plan: { id: "p1", text: "# Plan\n- Add parser\n- Render block", status: "proposed" } },
		],
		pendingNotice: undefined,
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));

	assert.match(output, /Proposed plan/);
	assert.match(output, /# Plan/);
	assert.match(output, /Add parser/);
	assert.doesNotMatch(output, /proposed_plan/);
});

test("mycli shell collapses consecutive context tool calls like Claude Code", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		transcript: [
			{ id: "read-1", kind: "tool", tool: { id: "read-1", name: "Read", args: "src/app.py", status: "success" } },
			{ id: "grep-1", kind: "tool", tool: { id: "grep-1", name: "Grep", args: "TODO", status: "success" } },
			{ id: "glob-1", kind: "tool", tool: { id: "glob-1", name: "Glob", args: "**/*.py", status: "success" } },
		],
		pendingNotice: undefined,
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));

	assert.match(output, /⏺ Read 1 file, searched 1 pattern, matched 1 glob/);
	assert.match(output, /⎿ src\/app\.py/);
	assert.match(output, /ctrl\+o to expand/);
	assert.doesNotMatch(output, /⏺ Grep/);
	assert.doesNotMatch(output, /⏺ Glob/);
});

test("mycli shell keeps consecutive Shell commands in Codex-style command cells", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		transcript: [
			{
				id: "shell-rg",
				kind: "bash",
				bash: {
					id: "shell-rg",
					toolName: "Shell",
					command: "rg mycli src",
					status: "success",
					outputPreview: "src/mycli/app.py",
				},
			},
			{
				id: "shell-find",
				kind: "bash",
				bash: {
					id: "shell-find",
					toolName: "Shell",
					command: "find src -name '*.py'",
					status: "running",
					outputPreview: "src/mycli/main.py",
				},
			},
		],
		pendingNotice: undefined,
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));

	assert.match(output, /• Ran rg mycli src/);
	assert.match(output, /• Running find src -name '\*\.py'/);
	assert.match(output, /└ src\/mycli\/main\.py/);
	assert.doesNotMatch(output, /running 2 commands|ran 2 commands/);
});

test("mycli shell applies context tool grouping to legacy tool arrays", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [
			{ id: "read-1", name: "Read", args: "src/app.py", status: "success" },
			{ id: "grep-1", name: "Grep", args: "TODO", status: "success" },
		],
		bash: [],
		transcript: undefined,
		pendingNotice: undefined,
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));

	assert.match(output, /⏺ Read 1 file, searched 1 pattern/);
	assert.doesNotMatch(output, /⏺ Grep/);
});

test("mycli shell labels running and failed collapsed context groups", () => {
	const runningState: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		transcript: [
			{ id: "read-1", kind: "tool", tool: { id: "read-1", name: "Read", args: "src/app.py", status: "running" } },
			{ id: "grep-1", kind: "tool", tool: { id: "grep-1", name: "Grep", args: "TODO", status: "success" } },
		],
		pendingNotice: undefined,
	};
	const runningOutput = stripAnsi(renderMycliShell(runningState, 100).join("\n"));
	assert.match(runningOutput, /⏺ Reading 1 file, searching 1 pattern · Running/);

	const failedState: MycliShellState = {
		...runningState,
		transcript: [
			{ id: "read-1", kind: "tool", tool: { id: "read-1", name: "Read", args: "src/app.py", status: "success" } },
			{ id: "grep-1", kind: "tool", tool: { id: "grep-1", name: "Grep", args: "TODO", status: "error", errorPreview: "boom" } },
		],
	};
	const failedOutput = stripAnsi(renderMycliShell(failedState, 100).join("\n"));
	assert.match(failedOutput, /⏺ Read 1 file, searched 1 pattern · Failed/);
});

test("mycli shell does not collapse context tools across mutating tools", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		transcript: [
			{ id: "read-1", kind: "tool", tool: { id: "read-1", name: "Read", args: "src/app.py", status: "success" } },
			{ id: "write-1", kind: "tool", tool: { id: "write-1", name: "Write", args: "src/app.py", status: "success", mutating: true, contentPreview: "x", contentLineCount: 1 } },
			{ id: "grep-1", kind: "tool", tool: { id: "grep-1", name: "Grep", args: "TODO", status: "success" } },
		],
		pendingNotice: undefined,
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));

	assert.match(output, /⏺ Read/);
	assert.match(output, /⏺ Write/);
	assert.match(output, /⏺ Grep/);
	assert.doesNotMatch(output, /Read 1 file, searched 1 pattern/);
});

test("file changes flush context groups and remain in transcript order", () => {
	const fileChange = {
		id: "write-1", callId: "call-1", status: "success" as const, summary: "Updated",
		files: [{
			version: 1 as const, kind: "update" as const, path: "src/app.py",
			diff: "@@ -1 +1 @@\n-old\n+new\n", addedLines: 1, removedLines: 1,
			truncated: false, omittedChars: 0, language: "py",
		}],
	};
	const state: MycliShellState = {
		...sampleState(), messages: [], tools: [], bash: [], pendingNotice: undefined,
		transcript: [
			{ id: "read-1", kind: "tool", tool: { id: "read-1", name: "Read", args: "before-a.py", status: "success" } },
			{ id: "read-2", kind: "tool", tool: { id: "read-2", name: "Read", args: "before-b.py", status: "success" } },
			{ id: "write-1", kind: "file_change", fileChange, message: { id: "write-1", role: "system", text: "fallback" } },
			{ id: "read-3", kind: "tool", tool: { id: "read-3", name: "Read", args: "after-a.py", status: "success" } },
			{ id: "read-4", kind: "tool", tool: { id: "read-4", name: "Read", args: "after-b.py", status: "success" } },
		],
	};
	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));
	const before = output.indexOf("before-a.py");
	const changed = output.indexOf("Edited src/app.py");
	const after = output.indexOf("after-a.py");

	assert.ok(before >= 0 && changed > before && after > changed, output);
	assert.equal((output.match(/Read 2 files/g) ?? []).length, 2);
	assert.doesNotMatch(output, /fallback|⏺ Write|⏺ Edit/);
});

test("mycli shell expands collapsed context tool groups into individual tools", () => {
	const state: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		transcript: [
			{ id: "read-1", kind: "tool", tool: { id: "read-1", name: "Read", args: "src/app.py", status: "success", expanded: true } },
			{ id: "grep-1", kind: "tool", tool: { id: "grep-1", name: "Grep", args: "TODO", status: "success", expanded: true } },
		],
		pendingNotice: undefined,
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));

	assert.match(output, /⏺ Read/);
	assert.match(output, /⏺ Grep/);
	assert.doesNotMatch(output, /Read 1 file, searched 1 pattern/);
});

test("mycli shell rendered lines stay width safe", () => {
	const width = 72;
	const lines = renderMycliShell(sampleState(), width);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line too wide: ${stripAnsi(line)}`);
	}
	assert.doesNotMatch(stripAnsi(lines.join("\n")), /Message mycli/);
});

test("footer renders two quiet idle rows", () => {
	const lines = new FooterComponent({
		cwd: "/Users/cosmos/Desktop/mycli/.worktrees/mycli-termcn-tui-polish",
		gitBranch: "feature/tui",
		sessionName: "现在都有哪些 skill 呢",
		provider: "deepseek/chat_completions",
		model: "deepseek-v4-flash",
		reasoningLevel: "medium",
		contextPercent: 11.3,
		contextWindow: 100000,
		trust: "trusted",
		collaborationMode: "default",
		liveState: "Idle",
		totalInputTokens: 64291,
		cacheReadTokens: 53120,
	}, { turnRunning: false, hasQueuedInput: false }).render(120);
	const output = stripAnsi(lines.join("\n"));

	assert.equal(lines.length, 2);
	assert.match(output, /enter send/);
	assert.match(output, /tab follow-up/);
	assert.match(output, /11\.3% ctx/);
	assert.match(output, /deepseek-v4-flash/);
	assert.doesNotMatch(output, /deepseek\/chat_completions|trust trusted|mode default|Idle|64k|R53k/);
});

test("footer exposes only actions and exceptional state that currently apply", () => {
	const output = stripAnsi(new FooterComponent({
		cwd: "/repo",
		model: "gpt-5.4",
		trust: "unknown",
		collaborationMode: "plan",
		liveState: "Running",
		backgroundShellCount: 2,
	}, { turnRunning: true, hasQueuedInput: true }).render(160).join("\n"));

	assert.match(output, /enter steer/);
	assert.match(output, /tab follow-up/);
	assert.match(output, /ctrl\+c interrupt/);
	assert.match(output, /option\+up edit follow-up/);
	assert.match(output, /trust\?/);
	assert.match(output, /plan/);
	assert.match(output, /Running/);
	assert.match(output, /2 background terminals/);
});

test("footer drops git branch before session title on narrow terminals", () => {
	const data = {
		cwd: "/Users/cosmos/Desktop/mycli/.worktrees/mycli-termcn-tui-polish",
		gitBranch: "feature/a-very-long-branch",
		sessionName: "修复 TUI 底栏",
		model: "deepseek-v4-flash",
		contextPercent: 11,
	};
	const narrow = new FooterComponent(data, { turnRunning: false, hasQueuedInput: false }).render(48);
	const wide = stripAnsi(new FooterComponent(data, { turnRunning: false, hasQueuedInput: false }).render(140).join("\n"));
	const narrowOutput = stripAnsi(narrow.join("\n"));

	assert.match(narrowOutput, /修复 TUI 底栏/);
	assert.doesNotMatch(narrowOutput, /feature\/a-very-long-branch/);
	assert.match(wide, /feature\/a-very-long-branch/);
	assert.equal(narrow.length, 2);
	for (const line of narrow) assert.ok(visibleWidth(line) <= 48, `line too wide: ${stripAnsi(line)}`);

	const cjkLines = new FooterComponent({
		cwd: "/很长的目录/另一个很长的目录/project",
		sessionName: "这是一个很长的中文会话标题",
	}, { turnRunning: false, hasQueuedInput: false }).render(24);
	assert.equal(cjkLines.length, 2);
	for (const line of cjkLines) assert.ok(visibleWidth(line) <= 24, `line too wide: ${stripAnsi(line)}`);
});

test("footer keeps compact shape width safe", () => {
	const footer = new FooterComponent({
		cwd: "/Users/cosmos/Desktop/mycli/.worktrees/mycli-termcn-tui-polish",
		gitBranch: "feature/a-very-long-branch-name-that-must-not-break-layout",
		sessionName: "a long session name",
		provider: "deepseek",
		model: "deepseek-v4-flash-with-a-long-suffix",
		reasoningLevel: "high",
		contextPercent: 91.2,
		contextWindow: 128000,
		totalInputTokens: 12345,
		totalOutputTokens: 98765,
		cacheReadTokens: 3333,
		cacheWriteTokens: 4444,
		cacheHitRate: 88.8,
		costUsd: 0.123,
		usingSubscription: true,
		autoCompact: true,
		steeringQueueCount: 1,
		followUpQueueCount: 1,
		trust: "trusted",
		collaborationMode: "plan",
		liveState: "Streaming",
		extensionStatuses: ["status\twith\ncontrol chars"],
	});

	const lines = footer.render(64);
	assert.ok(lines.length >= 3);
	assert.match(stripAnsi(lines.join("\n")), /~\/\.\.\.\/mycli-termcn-tui-polish/);
	assert.match(stripAnsi(lines.join("\n")), /91\.2% ctx/);
	assert.match(stripAnsi(lines.join("\n")), /status with control chars/);
	assert.doesNotMatch(stripAnsi(lines.join("\n")), /steer 1|follow-up 1|deepseek|CH88\.8|\$0\.123/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 64, `line too wide: ${stripAnsi(line)}`);
	}
});

test("footer omits queue counts at wide widths", () => {
	const output = stripAnsi(new FooterComponent({
		cwd: "/repo",
		steeringQueueCount: 2,
		followUpQueueCount: 3,
		queueCount: 5,
	}).render(160).join("\n"));

	assert.doesNotMatch(output, /steer 2|follow-up 3|queue 5/);
});

test("footer renders latest task progress when space allows", () => {
	const output = stripAnsi(new FooterComponent({
		cwd: "/repo",
		model: "gpt-5.4",
		taskProgress: { completed: 2, total: 5 },
	}).render(80).join("\n"));

	assert.match(output, /Tasks 2\/5/);
});

test("footer drops task progress before live status at narrow widths", () => {
	const output = stripAnsi(new FooterComponent({
		cwd: "/repo",
		model: "gpt-5.4-with-long-name",
		taskProgress: { completed: 2, total: 5 },
		liveState: "Running",
	}).render(32).join("\n"));

	assert.match(output, /Running/);
	assert.doesNotMatch(output, /Tasks 2\/5/);
});

test("pending input preview renders steering before follow-ups", () => {
	const rendered = new PendingInputPreviewComponent({
		pendingSteers: [{ text: "inspect current output", hasImages: false }],
		rejectedSteers: [],
		followUps: [{ text: "summarize afterward", hasImages: true }],
	});
	const output = stripAnsi(rendered.render(80).join("\n"));

	assert.match(output, /• Messages to be submitted after next tool call/);
	assert.match(output, /press esc to interrupt and send immediately/);
	assert.match(output, /↳ inspect current output/);
	assert.match(output, /• Queued follow-up inputs/);
	assert.match(output, /↳ summarize afterward/);
	assert.match(output, /(?:alt|option)\+up edit last queued message/);
	assert.ok(output.indexOf("Messages to be submitted") < output.indexOf("Queued follow-up inputs"));
});

test("pending input preview bounds multiline CJK messages at narrow widths", () => {
	const rendered = new PendingInputPreviewComponent({
		pendingSteers: [],
		rejectedSteers: [],
		followUps: [
			{
				text: "第一行中文内容需要自动换行\nsecond line with emoji ✓ and more words\nthird line\nfourth line",
				hasImages: false,
			},
		],
	});
	const lines = rendered.render(48);
	const plainLines = lines.map(stripAnsi);
	const headerIndex = plainLines.findIndex((line) => line.includes("Queued follow-up inputs"));
	const hintIndex = plainLines.findIndex((line) => line.includes("edit last queued message"));
	const messageLines = plainLines.slice(headerIndex + 1, hintIndex);

	assert.equal(messageLines.length, 3);
	assert.match(messageLines.join("\n"), /↳/);
	assert.match(messageLines.join("\n"), /…/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 48, `line too wide: ${stripAnsi(line)}`);
	}
});

test("pending preview renders three queue classes within its height budget", () => {
	const preview = new PendingInputPreviewComponent({
		pendingSteers: [{ text: "pending", hasImages: true }],
		rejectedSteers: [{ text: "rejected", hasImages: false }],
		followUps: Array.from({ length: 8 }, (_, index) => ({
			text: `later ${index}`,
			hasImages: false,
		})),
	}, { interruptHint: "f12", editHint: "shift+left", maxHeight: 12 });
	const lines = preview.render(52);
	const output = stripAnsi(lines.join("\n"));

	assert.match(output, /Messages to be submitted after next tool call/);
	assert.match(output, /attachment/);
	assert.match(output, /Messages to be submitted at end of turn/);
	assert.match(output, /Queued follow-up inputs/);
	assert.match(output, /f12 to interrupt/);
	assert.match(output, /shift\+left edit last queued message/);
	assert.match(output, /\.\.\. \+\d+ more/);
	assert.ok(lines.length <= 12);
});

test("pending preview bounds CJK and multiline input by visual width", () => {
	const width = 24;
	const preview = new PendingInputPreviewComponent({
		pendingSteers: [{
			text: "检查最新命令输出\n然后继续处理这个很长的任务",
			hasImages: false,
		}],
		rejectedSteers: [],
		followUps: [],
	}, { interruptHint: "esc", editHint: "alt+up", maxHeight: 8 });
	const lines = preview.render(width);

	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line too wide: ${stripAnsi(line)}`);
	}
	assert.ok(lines.length <= 8);
});

test("footer renders collaboration mode when space allows", () => {
	const footer = new FooterComponent({
		cwd: "/repo",
		model: "gpt-5.4",
		collaborationMode: "plan",
		liveState: "Plan",
	});

	const output = stripAnsi(footer.render(48).join("\n"));

	assert.match(output, /plan/);
});

test("background terminal footer uses singular plural and hides zero", () => {
	const one = stripAnsi(new FooterComponent({ cwd: "/repo", backgroundShellCount: 1 }).render(120).join("\n"));
	const two = stripAnsi(new FooterComponent({ cwd: "/repo", backgroundShellCount: 2 }).render(120).join("\n"));
	const zero = stripAnsi(new FooterComponent({ cwd: "/repo", backgroundShellCount: 0 }).render(120).join("\n"));

	assert.match(one, /1 background terminal/);
	assert.match(two, /2 background terminals/);
	assert.doesNotMatch(zero, /background terminal/);
});

test("mycli shell renders ps history with empty and multiline background terminals", () => {
	const populated = stripAnsi(renderMycliShell({
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		pendingNotice: undefined,
		transcript: [
			{
				id: "ps-1",
				kind: "background_terminals",
				backgroundTerminals: {
					id: "ps-1",
					processes: [
						{
							shellId: "shell-1",
							commandPreview: "uv run dev",
							recentOutput: ["starting", "ready"],
						},
					],
				},
			},
		],
	}, 100).join("\n"));
	const empty = stripAnsi(renderMycliShell({
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		pendingNotice: undefined,
		transcript: [
			{
				id: "ps-empty",
				kind: "background_terminals",
				backgroundTerminals: { id: "ps-empty", processes: [] },
			},
		],
	}, 100).join("\n"));

	assert.match(populated, /\/ps/);
	assert.match(populated, /Background terminals/);
	assert.match(populated, /• uv run dev/);
	assert.match(populated, /↳ starting/);
	assert.match(populated, /↳ ready/);
	assert.match(empty, /No background terminals running\./);
});

test("ps history bounds long commands and caps the process list at sixteen", () => {
	const processes = Array.from({ length: 20 }, (_, index) => ({
		shellId: `shell-${index + 1}`,
		commandPreview: index === 0 ? `python ${"x".repeat(200)}` : `uv run worker-${index + 1}`,
		recentOutput: [],
	}));
	const lines = renderMycliShell({
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		pendingNotice: undefined,
		transcript: [
			{
				id: "ps-many",
				kind: "background_terminals",
				backgroundTerminals: { id: "ps-many", processes },
			},
		],
	}, 60);
	const output = stripAnsi(lines.join("\n"));

	assert.equal((output.match(/^  • /gm) ?? []).length, 16);
	assert.match(output, /\.\.\. and 4 more running/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 60, `line too wide: ${stripAnsi(line)}`);
	}
});

test("mycli shell renders legacy command diagnostics as compact cards", () => {
	const output = renderMycliShell({
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		pendingNotice: undefined,
		transcript: [
			{
				id: "diag-usage",
				kind: "diagnostic",
				diagnostic: {
					id: "diag-usage",
					command: "/usage",
					title: "Usage",
					kind: "usage",
					metrics: [
						{ label: "Turns with usage", value: "3", accent: "accent" },
						{ label: "Estimated cost", value: "0.123", accent: "success" },
					],
					sections: [
						{
							title: "Cumulative tokens",
							rows: [
								{ label: "Input tokens", value: "100000", accent: "muted" },
								{ label: "Cache read tokens", value: "90000", accent: "success" },
							],
						},
					],
				},
			},
			{
				id: "diag-context",
				kind: "diagnostic",
				diagnostic: {
					id: "diag-context",
					command: "/context",
					title: "Context",
					kind: "context",
					metrics: [{ label: "Used", value: "71.1%", accent: "warning" }],
					sections: [
						{
							title: "Context composition",
							rows: [{ label: "Duplicate tool result tokens", value: "3000", accent: "warning" }],
						},
					],
				},
			},
		],
	}, 100);
	const plain = stripAnsi(output.join("\n"));

	assert.match(plain, /\/usage\n\n╭─+/);
	assert.match(plain, /│  Usage/);
	assert.match(plain, /Estimated cost\s+0\.123/);
	assert.match(plain, /Cumulative tokens/);
	assert.match(plain, /\/context\n\n╭─+/);
	assert.match(plain, /│  Context/);
	assert.match(plain, /Context composition/);
	assert.doesNotMatch(plain, /\[usage\] cumulative_usage/);
});

test("mycli shell routes structured command results to semantic rendering", () => {
	const output = renderMycliShell({
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		pendingNotice: undefined,
		transcript: [
			{
				id: "command-undo",
				kind: "command_result",
				commandResult: {
					id: "command-undo",
					display: {
						version: 1,
						kind: "notice",
						command: "/undo",
						title: "Undo complete",
						severity: "success",
						summary: "Restored app.py",
						fields: [],
						rows: [],
						sections: [],
						suggestions: [],
						omittedRows: 0,
						omittedChars: 0,
					},
					fallbackLines: ["Restored app.py"],
					folded: false,
				},
			},
		],
	}, 80);

	assert.match(stripAnsi(output.join("\n")), /✓ Restored app\.py/);
});

test("tool rendering stays collapsed until expanded and marks failure", () => {
	const longOutput = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
	const collapsed = new ToolExecutionComponent({
		id: "tool",
		name: "Edit",
		args: "/Users/cosmos/Desktop/mycli/word.txt",
		status: "success",
		mutating: true,
		outputPreview: longOutput,
		hiddenLineCount: 18,
	});
	let output = stripAnsi(collapsed.render(80).join("\n"));
	assert.match(output, /Edit/);
	assert.match(output, /⎿ \/Users\/cosmos\/Desktop\/mycli\/word\.txt · line 1/);
	assert.match(output, /more lines/);
	assert.doesNotMatch(output, /line 1\n/);

	const expanded = new ToolExecutionComponent({
		id: "tool",
		name: "Edit",
		args: "/Users/cosmos/Desktop/mycli/word.txt",
		status: "success",
		mutating: true,
		outputPreview: longOutput,
		expanded: true,
	});
	output = stripAnsi(expanded.render(80).join("\n"));
	assert.match(output, /line 1/);
	assert.match(output, /line 30/);

	const failed = new ToolExecutionComponent({
		id: "bad",
		name: "Bash",
		args: "pytest -q",
		status: "error",
		errorPreview: "Traceback\nboom",
		durationMs: 1250,
	});
	output = stripAnsi(failed.render(80).join("\n"));
	assert.match(output, /⎿ pytest -q · Traceback/);
	assert.match(output, /boom/);
	assert.match(output, /1\.3s/);
});

test("skill rendering shows the concrete skill name without repeating it", () => {
	const rendered = new ToolExecutionComponent({
		id: "skill",
		name: "Skill",
		args: "repository-analysis",
		status: "success",
		outputPreview: "Activated skill: repository-analysis",
	});

	const output = stripAnsi(rendered.render(80).join("\n"));

	assert.match(output, /⏺ Skill repository-analysis/);
	assert.match(output, /⎿ Activated/);
	assert.doesNotMatch(output, /⎿ repository-analysis/);
});

test("tool rendering keeps display summary and detail separate", () => {
	const rendered = new ToolExecutionComponent({
		id: "grep",
		name: "Grep",
		args: "src: ToolResult",
		status: "success",
		summaryPreview: "12 matches",
		detailPreview: "src/a.py:10: class ToolResult",
		presentation: "context",
	});

	const output = stripAnsi(rendered.render(100).join("\n"));
	assert.match(output, /⎿ src: ToolResult · 12 matches/);
	assert.match(output, /src\/a\.py:10: class ToolResult/);
	assert.equal(output.match(/12 matches/g)?.length, 1);
});

test("tool rendering previews write content like coding-agent", () => {
	const content = Array.from({ length: 13 }, (_, index) => `doc line ${index + 1}`).join("\n");
	const collapsed = new ToolExecutionComponent({
		id: "write",
		name: "Write",
		args: "docs/notes.md",
		status: "success",
		mutating: true,
		contentPreview: content,
		contentLineCount: 13,
	});

	let output = stripAnsi(collapsed.render(100).join("\n"));
	assert.match(output, /⏺ Write/);
	assert.doesNotMatch(output, /⏺ Write\(docs\/notes\.md\)/);
	assert.match(output, /⎿ docs\/notes\.md · Wrote 13 lines/);
	assert.match(output, /doc line 1/);
	assert.match(output, /doc line 10/);
	assert.doesNotMatch(output, /doc line 13/);
	assert.match(output, /\(3 more lines, 13 total,/);

	const expanded = new ToolExecutionComponent({
		id: "write",
		name: "Write",
		args: "docs/notes.md",
		status: "success",
		mutating: true,
		contentPreview: content,
		contentLineCount: 13,
		expanded: true,
	});
	output = stripAnsi(expanded.render(100).join("\n"));
	assert.match(output, /doc line 13/);
});

test("tool rendering shows mutation diffs instead of success summaries", () => {
	const rendered = new ToolExecutionComponent({
		id: "edit",
		name: "Edit",
		args: "src/app.py",
		status: "success",
		mutating: true,
		diffPreview: "@@ -1 +1 @@\n-old\n+new",
		outputPreview: undefined,
	});

	const output = stripAnsi(rendered.render(100).join("\n"));
	assert.match(output, /⎿ Updated src\/app\.py/);
	assert.doesNotMatch(output, /@@ -1 \+1 @@/);
	assert.match(output, /-old/);
	assert.match(output, /\+new/);
});

test("bash rendering keeps long commands folded in a Codex-style command cell", () => {
	const longCommand = ["python - <<'PY'", ...Array.from({ length: 20 }, () => "print('hello')"), "PY"].join("\n");
	const rendered = new BashExecutionComponent({
		id: "bash",
		command: longCommand,
		status: "running",
	}, () => Date.parse("2026-07-11T12:00:00Z"));

	const output = stripAnsi(rendered.render(100).join("\n"));

	assert.match(output, /• Running python - <<'PY'…/);
	assert.doesNotMatch(output, /print\('hello'\)/);
});

test("multiline Shell command preview uses one bounded ellipsis", () => {
	const rendered = new BashExecutionComponent({
		id: "shell-long-first-line",
		command: `\n${"x".repeat(100)}\necho hidden`,
		status: "running",
	});

	const output = stripAnsi(rendered.render(120).join("\n"));

	assert.match(output, /x…/);
	assert.doesNotMatch(output, /……/);
	assert.doesNotMatch(output, /echo hidden/);
});

test("running Shell output keeps only the newest five visual rows", () => {
	const rendered = new BashExecutionComponent({
		id: "shell-running-output",
		command: "generate output",
		status: "running",
		outputPreview: Array.from({ length: 7 }, (_, index) => `output ${index + 1}`).join("\n"),
	});

	const output = stripAnsi(rendered.render(100).join("\n"));

	assert.doesNotMatch(output, /output 1/);
	assert.doesNotMatch(output, /output 2/);
	assert.match(output, /└ output 3/);
	assert.match(output, /output 7/);
});

test("completed Shell output keeps a five-row head and tail summary", () => {
	const rendered = new BashExecutionComponent({
		id: "shell-completed-output",
		command: "generate output",
		status: "success",
		outputPreview: Array.from({ length: 7 }, (_, index) => `output ${index + 1}`).join("\n"),
	});

	const output = stripAnsi(rendered.render(100).join("\n"));

	assert.match(output, /output 1/);
	assert.match(output, /output 2/);
	assert.doesNotMatch(output, /output 3/);
	assert.doesNotMatch(output, /output 5/);
	assert.match(output, /3 more lines/);
	assert.match(output, /output 6/);
	assert.match(output, /output 7/);
});

test("Codex-style foreground Bash shows elapsed interrupt hint", () => {
	const now = Date.parse("2026-07-11T12:00:08Z");
	const foreground = new BashExecutionComponent(
		{
			id: "bash-1",
			command: "uv run pytest -q",
			status: "running",
			background: false,
			startedAt: "2026-07-11T12:00:00Z",
		},
		() => now,
	);

	const output = stripAnsi(foreground.render(100).join("\n"));
	assert.match(output, /• Running uv run pytest -q \(8s · esc to interrupt\)/);
});

test("expanded Shell command renders active profile and legacy Bash label", () => {
	const powershell = stripAnsi(
		new BashExecutionComponent({
			id: "shell-pwsh",
			toolName: "Shell",
			command: "Get-Location",
			status: "success",
			shellKind: "powershell",
			shellEdition: "core",
			expanded: true,
		}).render(100).join("\n"),
	);
	const legacy = stripAnsi(
		new BashExecutionComponent({
			id: "shell-bash",
			toolName: "Bash",
			command: "pwd",
			status: "success",
			expanded: true,
		}).render(100).join("\n"),
	);

	assert.match(powershell, /Shell: PowerShell 7/);
	assert.match(legacy, /Shell: Bash/);
});

test("expanded Shell command reveals the complete command and retained output", () => {
	const command = ["python - <<'PY'", "print('complete command')", "PY"].join("\n");
	const outputPreview = Array.from({ length: 7 }, (_, index) => `retained output ${index + 1}`).join("\n");
	const rendered = new BashExecutionComponent({
		id: "shell-expanded-details",
		toolName: "Shell",
		command,
		status: "success",
		shellKind: "zsh",
		outputPreview,
		expanded: true,
	});

	const output = stripAnsi(rendered.render(100).join("\n"));

	assert.match(output, /Command:/);
	assert.match(output, /print\('complete command'\)/);
	assert.match(output, /retained output 1/);
	assert.match(output, /retained output 7/);
});

test("Codex-style background Bash omits active-turn interrupt hint", () => {
	const background = new BashExecutionComponent(
		{
			id: "bash-2",
			command: "uv run dev",
			status: "running",
			background: true,
		},
		() => Date.parse("2026-07-11T12:00:08Z"),
	);

	const output = stripAnsi(background.render(100).join("\n"));
	assert.match(output, /• Running uv run dev/);
	assert.doesNotMatch(output, /esc to interrupt/);
});

test("yielded Shell omits active-turn interrupt hint", () => {
	const yielded = new BashExecutionComponent(
		{
			id: "shell-yielded",
			command: "uv run pytest -q",
			status: "running",
			background: false,
			yielded: true,
		},
		() => Date.parse("2026-07-11T12:00:08Z"),
	);

	const output = stripAnsi(yielded.render(100).join("\n"));
	assert.match(output, /• Running uv run pytest -q/);
	assert.doesNotMatch(output, /esc to interrupt/);
});

test("Codex-style failed Bash uses Ran title and exit detail", () => {
	const failed = new BashExecutionComponent(
		{
			id: "bash-3",
			command: "uv run pytest -q",
			status: "error",
			exitCode: 2,
			terminalState: "failed",
		},
		() => Date.parse("2026-07-11T12:00:08Z"),
	);

	const output = stripAnsi(failed.render(100).join("\n"));
	assert.match(output, /• Ran uv run pytest -q/);
	assert.match(output, /└ exit 2/);
});

test("trust selector owns keyboard selection", () => {
	let selected: boolean | null = null;
	let cancelled = false;
	const selector = new TrustSelectorComponent({
		cwd: "/repo/mycli",
		savedDecision: null,
		projectTrusted: false,
		onSelect: (trusted) => {
			selected = trusted;
		},
		onCancel: () => {
			cancelled = true;
		},
	});

	let output = stripAnsi(selector.render(80).join("\n"));
	assert.match(output, /Project trust/);
	assert.match(output, /Saved decision: none/);
	assert.match(output, /Current session: untrusted/);
	assert.match(output, /→ Trust/);

	selector.handleInput("j");
	output = stripAnsi(selector.render(80).join("\n"));
	assert.match(output, /→ Do not trust/);

	selector.handleInput("\n");
	assert.equal(selected, false);

	selector.handleInput("\x1b");
	assert.equal(cancelled, true);
});

test("mycli shell runtime assembles mounted containers", () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({ initialState: sampleState(), terminal });

	assert.equal(runtime.transcriptContainer.children[0], runtime.headerContainer);
	assert.equal(runtime.transcriptContainer.children[1], runtime.chatContainer);
	assert.equal(runtime.ui.children[0], runtime.transcriptViewport);
	assert.equal(runtime.ui.children[1], runtime.pendingMessagesContainer);
	assert.equal(runtime.ui.children[2], runtime.statusContainer);
	assert.equal(runtime.ui.children[3], runtime.editorContainer);
	assert.equal(runtime.ui.children[4], runtime.subagentTaskContainer);
	assert.equal(runtime.ui.children[5], runtime.footerContainer);

	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /mycli/);
	assert.match(output, /Read word\.txt/);
	assert.match(output, /enter send/);
	assert.doesNotMatch(output, /Message mycli/);
	assert.doesNotMatch(output, /mycli-shell\/~/);
	assert.match(output, /deepseek-v4-flash/);
});

test("mycli shell runtime reuses chrome layout only within one root render frame", () => {
	const runtime = new MycliShellRuntime({ initialState: sampleState(), terminal: new TestTerminal() });
	const renderEditor = runtime.editor.render.bind(runtime.editor);
	let editorRenders = 0;
	runtime.editor.render = (width) => {
		editorRenders += 1;
		return renderEditor(width);
	};

	runtime.ui.render(100);
	assert.equal(editorRenders, 1);
	runtime.ui.render(100);
	assert.equal(editorRenders, 2);

	runtime.editorContainer.render(100);
	runtime.editorContainer.render(100);
	assert.equal(editorRenders, 4);
});

test("mycli shell runtime updates footer actions with turn and queue state", () => {
	const runtime = new MycliShellRuntime({ initialState: sampleState(), terminal: new TestTerminal() });
	let output = stripAnsi(runtime.footerContainer.render(180).join("\n"));
	assert.match(output, /enter send/);
	assert.doesNotMatch(output, /ctrl\+c interrupt|edit follow-up/);

	runtime.setState({
		...runtime.getState(),
		footer: { ...runtime.getState().footer, liveState: "Running" },
	});
	output = stripAnsi(runtime.footerContainer.render(180).join("\n"));
	assert.match(output, /enter steer/);
	assert.match(output, /ctrl\+c interrupt/);
	assert.doesNotMatch(output, /edit follow-up/);

	runtime.setState({
		...runtime.getState(),
		footer: { ...runtime.getState().footer, hasPendingInput: true },
	});
	output = stripAnsi(runtime.footerContainer.render(180).join("\n"));
	assert.match(output, /option\+up edit follow-up/);
});

test("mycli shell runtime updates transcript tool components in place", () => {
	const terminal = new TestTerminal();
	const initial: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [{ id: "tool-1", name: "Read", args: "word.txt", status: "running" }],
		bash: [],
		transcript: [
			{ id: "tool-1", kind: "tool", tool: { id: "tool-1", name: "Read", args: "word.txt", status: "running" } },
		],
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	const component = runtime.chatContainer.children[0];

	runtime.setState({
		...initial,
		tools: [{ id: "tool-1", name: "Read", args: "word.txt", status: "success", outputPreview: "3 lines" }],
		transcript: [
			{
				id: "tool-1",
				kind: "tool",
				tool: { id: "tool-1", name: "Read", args: "word.txt", status: "success", outputPreview: "3 lines" },
			},
		],
	});

	assert.equal(runtime.chatContainer.children[0], component);
	assert.match(stripAnsi(runtime.chatContainer.render(100).join("\n")), /⎿ word\.txt · 3 lines/);
	assert.match(stripAnsi(runtime.chatContainer.render(100).join("\n")), /3 lines/);
});

test("running Write becomes one file change component and updates in place", () => {
	const terminal = new TestTerminal();
	const runningTool = { id: "change-1", name: "Write", args: "src/app.py", status: "running" as const, mutating: true };
	const initial: MycliShellState = {
		...sampleState(), messages: [], tools: [runningTool], bash: [], pendingNotice: undefined,
		transcript: [{ id: "change-1", kind: "tool", tool: runningTool }],
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	assert.ok(runtime.chatContainer.children[0] instanceof ToolExecutionComponent);

	const fileChange = {
		id: "change-1", callId: "call-1", status: "success" as const, summary: "Updated",
		files: [{
			version: 1 as const, kind: "update" as const, path: "src/app.py",
			diff: "@@ -1 +1 @@\n-old\n+new\n", addedLines: 1, removedLines: 1,
			truncated: false, omittedChars: 0, language: "py",
		}],
	};
	runtime.setState({
		...initial, tools: [],
		transcript: [{ id: "change-1", kind: "file_change", fileChange, message: { id: "change-1", role: "system", text: "fallback" } }],
	});
	const completedComponent = runtime.chatContainer.children[0];
	assert.ok(completedComponent instanceof FileChangeComponent);
	assert.equal(runtime.chatContainer.children.length, 1);
	assert.doesNotMatch(stripAnsi(runtime.chatContainer.render(100).join("\n")), /fallback|⏺ Write/);

	runtime.setState({
		...runtime.getState(),
		transcript: [{
			id: "change-1", kind: "file_change",
			fileChange: { ...fileChange, summary: "Updated again" },
			message: { id: "change-1", role: "system", text: "fallback" },
		}],
	});
	assert.equal(runtime.chatContainer.children[0], completedComponent);
});

test("global detail toggle never hides file change diffs", () => {
	const terminal = new TestTerminal();
	const fileChange = {
		id: "change-1", status: "success" as const, summary: "Updated",
		files: [{
			version: 1 as const, kind: "update" as const, path: "src/app.py",
			diff: "@@ -1 +1 @@\n-old-visible\n+new-visible\n", addedLines: 1, removedLines: 1,
			truncated: false, omittedChars: 0, language: "py",
		}],
	};
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(), messages: [], tools: [], bash: [], pendingNotice: undefined,
			transcript: [{ id: "change-1", kind: "file_change", fileChange, message: { id: "change-1", role: "system", text: "fallback" } }],
		},
		terminal,
	});
	runtime.start();
	terminal.input?.("\x0f");

	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /old-visible/);
	assert.match(output, /new-visible/);
});

test("mycli shell runtime streams output into the mounted Shell component", () => {
	const terminal = new TestTerminal();
	const initialBash = {
		id: "shell-1",
		toolName: "Shell",
		command: "uv run pytest -q",
		status: "running" as const,
		shellId: "shell-1",
		callId: "call-1",
		outputPreview: "collecting\n",
	};
	const initial: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [initialBash],
		transcript: [{ id: "shell-1", kind: "bash", bash: initialBash }],
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	const component = runtime.chatContainer.children[0];
	const updatedBash = { ...initialBash, outputPreview: "collecting\n1 passed\n" };

	runtime.setState({
		...initial,
		bash: [updatedBash],
		transcript: [{ id: "shell-1", kind: "bash", bash: updatedBash }],
	});

	assert.equal(runtime.chatContainer.children[0], component);
	assert.match(stripAnsi(runtime.chatContainer.render(100).join("\n")), /1 passed/);
});

test("mycli shell runtime updates assistant transcript components in place", () => {
	const terminal = new TestTerminal();
	const initial: MycliShellState = {
		...sampleState(),
		messages: [{ id: "assistant-1", role: "assistant", text: "hel" }],
		tools: [],
		bash: [],
		transcript: [
			{ id: "assistant-1", kind: "message", message: { id: "assistant-1", role: "assistant", text: "hel" } },
		],
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	const component = runtime.chatContainer.children[0];
	const runtimeInternals = runtime as unknown as {
		blockSignature(block: unknown): string;
	};
	const blockSignature = runtimeInternals.blockSignature.bind(runtime);
	runtimeInternals.blockSignature = (block) => {
		if (
			typeof block === "object" &&
			block !== null &&
			"kind" in block &&
			block.kind === "message"
		) {
			throw new Error("assistant updates must not serialize the transcript block");
		}
		return blockSignature(block);
	};

	runtime.setState(
		{
			...initial,
			messages: [{ id: "assistant-1", role: "assistant", text: "hello" }],
			transcript: [
				{ id: "assistant-1", kind: "message", message: { id: "assistant-1", role: "assistant", text: "hello" } },
			],
		},
		{ transcriptUpdate: "tail" },
	);

	assert.equal(runtime.chatContainer.children[0], component);
	assert.match(stripAnsi(runtime.chatContainer.render(100).join("\n")), /hello/);
});

test("mycli shell runtime regroups context tools on a hinted tail append", () => {
	const terminal = new TestTerminal();
	const firstTool = {
		id: "read-1",
		name: "Read",
		args: "one.ts",
		status: "success" as const,
		outputPreview: "one",
		presentation: "context",
	};
	const initial: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [firstTool],
		bash: [],
		transcript: [{ id: firstTool.id, kind: "tool", tool: firstTool }],
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	const secondTool = {
		...firstTool,
		id: "read-2",
		args: "two.ts",
		outputPreview: "two",
	};

	runtime.setState(
		{
			...initial,
			tools: [firstTool, secondTool],
			transcript: [
				{ id: firstTool.id, kind: "tool", tool: firstTool },
				{ id: secondTool.id, kind: "tool", tool: secondTool },
			],
		},
		{ transcriptUpdate: "tail" },
	);

	assert.equal(runtime.chatContainer.children.length, 1);
	assert.match(stripAnsi(runtime.chatContainer.render(100).join("\n")), /Read 2 files/);
});

test("mycli shell runtime renders pending queued input previews", () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingInput: {
				pendingSteers: [{ text: "inspect current output", hasImages: false }],
				rejectedSteers: [],
				followUps: [{ text: "summarize afterward", hasImages: false }],
			},
		},
		terminal,
	});

	const output = stripAnsi(runtime.pendingMessagesContainer.render(100).join("\n"));

	assert.match(output, /Messages to be submitted after next tool call/);
	assert.match(output, /↳ inspect current output/);
	assert.match(output, /Queued follow-up inputs/);
	assert.match(output, /↳ summarize afterward/);
	assert.doesNotMatch(output, /Pending input: steer/);
});

test("mycli shell runtime refreshes pending input previews when queues change", () => {
	const terminal = new TestTerminal();
	const initial: MycliShellState = { ...sampleState(), pendingNotice: undefined };
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });

	runtime.setState({
		...initial,
		pendingInput: {
			pendingSteers: [{ text: "inspect the latest output", hasImages: false }],
			rejectedSteers: [],
			followUps: [{ text: "summarize after completion", hasImages: false }],
		},
	});

	const queuedOutput = stripAnsi(runtime.pendingMessagesContainer.render(100).join("\n"));
	assert.match(queuedOutput, /Messages to be submitted after next tool call/);
	assert.match(queuedOutput, /inspect the latest output/);
	assert.match(queuedOutput, /Queued follow-up inputs/);
	assert.match(queuedOutput, /summarize after completion/);

	runtime.setState(initial);

	assert.equal(runtime.pendingMessagesContainer.render(100).length, 0);
});

test("mycli shell runtime does not rebuild stable chrome during assistant streaming", () => {
	const terminal = new TestTerminal();
	const initial: MycliShellState = {
		...sampleState(),
		messages: [{ id: "assistant-1", role: "assistant", text: "hel" }],
		tools: [],
		bash: [],
		transcript: [
			{ id: "assistant-1", kind: "message", message: { id: "assistant-1", role: "assistant", text: "hel" } },
		],
		pendingNotice: undefined,
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	const headerChildren = [...runtime.headerContainer.children];
	const pendingChildren = [...runtime.pendingMessagesContainer.children];
	const statusChildren = [...runtime.statusContainer.children];
	const footerChildren = [...runtime.footerContainer.children];

	runtime.setState({
		...initial,
		messages: [{ id: "assistant-1", role: "assistant", text: "hello" }],
		transcript: [
			{ id: "assistant-1", kind: "message", message: { id: "assistant-1", role: "assistant", text: "hello" } },
		],
	});

	assert.deepEqual(runtime.headerContainer.children, headerChildren);
	assert.deepEqual(runtime.pendingMessagesContainer.children, pendingChildren);
	assert.deepEqual(runtime.statusContainer.children, statusChildren);
	assert.deepEqual(runtime.footerContainer.children, footerChildren);
});

test("mycli shell runtime uses diff rendering for streaming state updates", async () => {
	const terminal = new TestTerminal();
	const initial: MycliShellState = {
		...sampleState(),
		messages: [{ id: "assistant-1", role: "assistant", text: "hel" }],
		tools: [],
		bash: [],
		transcript: [
			{ id: "assistant-1", kind: "message", message: { id: "assistant-1", role: "assistant", text: "hel" } },
		],
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });

	runtime.start();
	await setTimeout(25);
	const clearsAfterStart = terminal.fullClearCount();
	runtime.setState({
		...initial,
		messages: [{ id: "assistant-1", role: "assistant", text: "hello" }],
		transcript: [
			{ id: "assistant-1", kind: "message", message: { id: "assistant-1", role: "assistant", text: "hello" } },
		],
	});
	await setTimeout(25);

	assert.equal(terminal.fullClearCount(), clearsAfterStart);
	assert.equal(runtime.ui.fullRedraws, 1);
});

test("stream deltas do not synchronously rerender the full transcript", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	const initial: MycliShellState = {
		...sampleState(),
		messages: [{ id: "assistant-1", role: "assistant", text: "hello" }],
		tools: [],
		bash: [],
		transcript: [
			{ id: "assistant-1", kind: "message", message: { id: "assistant-1", role: "assistant", text: "hello" } },
		],
		pendingNotice: undefined,
		footer: { ...sampleState().footer, liveState: "Running" },
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	runtime.start();
	await setTimeout(25);

	const renderTranscript = runtime.transcriptViewport.render.bind(runtime.transcriptViewport);
	let transcriptRenders = 0;
	runtime.transcriptViewport.render = (width) => {
		transcriptRenders += 1;
		return renderTranscript(width);
	};

	runtime.setState({
		...initial,
		messages: [{ id: "assistant-1", role: "assistant", text: "hello world" }],
		transcript: [
			{ id: "assistant-1", kind: "message", message: { id: "assistant-1", role: "assistant", text: "hello world" } },
		],
	});

	assert.equal(transcriptRenders, 0);
	await setTimeout(25);
	assert.ok(transcriptRenders > 0);
});

test("mycli shell runtime keeps Codex-style working status below the transcript for the active turn", async () => {
	const terminal = new TestTerminal();
	let now = 10_000;
	const runtime = new MycliShellRuntime({
		initialState: { ...sampleState(), footer: { ...sampleState().footer, liveState: "Idle" } },
		terminal,
		now: () => now,
	});

	runtime.setState({ ...runtime.getState(), footer: { ...runtime.getState().footer, liveState: "Running" } });
	let output = stripAnsi(runtime.statusContainer.render(100).join("\n"));
	assert.match(output, /Working \(0s • esc to interrupt\)/);
	assert.doesNotMatch(stripAnsi(runtime.chatContainer.render(100).join("\n")), /Working/);

	now = 12_400;
	runtime.refreshTurnStatus();
	output = stripAnsi(runtime.statusContainer.render(100).join("\n"));
	assert.match(output, /Working \(2s • esc to interrupt\)/);

	now = 13_100;
	runtime.setState({ ...runtime.getState(), footer: { ...runtime.getState().footer, liveState: "Completed" } });
	output = stripAnsi(runtime.chatContainer.render(100).join("\n"));
	assert.match(output, /✻ Completed for 3 s/);
	assert.equal(stripAnsi(runtime.statusContainer.render(100).join("\n")), "");
});

test("working elapsed continues while the active turn waits on a tool", () => {
	const terminal = new TestTerminal();
	let now = 10_000;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Idle", turnRunning: false },
		},
		terminal,
		now: () => now,
	});

	runtime.setState({
		...runtime.getState(),
		footer: {
			...runtime.getState().footer,
			liveState: "Running",
			liveStateKind: "running",
			turnRunning: true,
		},
	});
	now = 12_400;
	runtime.setState({
		...runtime.getState(),
		footer: {
			...runtime.getState().footer,
			liveState: "Waiting for background terminal",
			liveStateKind: "waiting_background_terminal",
			turnRunning: true,
		},
	});

	let output = stripAnsi(runtime.statusContainer.render(100).join("\n"));
	assert.match(output, /Working \(2s • esc to interrupt\)/);
	assert.match(output, /Waiting for background terminal/);

	now = 15_100;
	runtime.setState({
		...runtime.getState(),
		footer: {
			...runtime.getState().footer,
			liveState: "Completed",
			liveStateKind: "completed",
			turnRunning: false,
		},
	});
	output = stripAnsi(runtime.chatContainer.render(100).join("\n"));
	assert.match(output, /✻ Completed for 5 s/);
});

test("mycli shell runtime keeps clear-on-shrink disabled like coding-agent default", async () => {
	const terminal = new TestTerminal();
	const initial: MycliShellState = {
		...sampleState(),
		messages: [],
		tools: [],
		bash: [],
		transcript: [
			{
				id: "assistant-1",
				kind: "message",
				message: {
					id: "assistant-1",
					role: "assistant",
					text: Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n"),
				},
			},
		],
		pendingNotice: "waiting\n".repeat(20),
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });

	runtime.start();
	await setTimeout(25);
	const redrawsAfterStart = runtime.ui.fullRedraws;
	const clearsAfterStart = terminal.fullClearCount();

	runtime.setState({
		...initial,
		pendingNotice: undefined,
	});
	await setTimeout(25);

	assert.equal(runtime.ui.getClearOnShrink(), false);
	assert.equal(runtime.ui.fullRedraws, redrawsAfterStart);
	assert.equal(terminal.fullClearCount(), clearsAfterStart);
});

test("mycli shell runtime gates startup with editor selector", async () => {
	const terminal = new TestTerminal();
	let exited = false;
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		requireTrust: true,
		onExit: () => {
			exited = true;
		},
	});

	runtime.start();
	await setTimeout(25);
	assert.equal(terminal.started, true);
	let output = stripAnsi(terminal.output);
	assert.match(output, /Project trust/);
	assert.doesNotMatch(output, /enter send/);
	assert.equal(runtime.ui.children[0], runtime.editorContainer);
	assert.equal(runtime.ui.children.length, 1);

	terminal.input?.("j");
	terminal.input?.("\r");
	await setTimeout(25);
	assert.equal(exited, true);
	assert.equal(terminal.stopped, true);
});

test("mycli shell runtime enters main UI only after trust selection", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		requireTrust: true,
	});

	runtime.start();
	await setTimeout(25);
	assert.doesNotMatch(stripAnsi(terminal.output), /enter send/);
	assert.equal(runtime.ui.children.length, 1);

	terminal.input?.("\r");
	await setTimeout(25);
	const output = stripAnsi(terminal.output);
	assert.match(output, /enter send/);
	assert.match(output, /deepseek-v4-flash/);
	assert.equal(runtime.getState().footer.trust, "trusted");
	assert.equal(runtime.ui.children[0], runtime.transcriptViewport);
	assert.equal(runtime.ui.children[3], runtime.editorContainer);
	assert.equal(runtime.ui.children.length, 6);
});

test("mycli shell runtime persists trust before entering the main UI", async () => {
	const terminal = new TestTerminal();
	const selections: boolean[] = [];
	let releaseSave!: () => void;
	const saveReleased = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		requireTrust: true,
		onTrustSelect: async (trusted) => {
			selections.push(trusted);
			await saveReleased;
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\r");
	await setTimeout(25);

	assert.deepEqual(selections, [true]);
	assert.equal(runtime.ui.children.length, 1);
	assert.match(stripAnsi(terminal.output), /Project trust/);

	releaseSave();
	await setTimeout(25);

	assert.equal(runtime.getState().footer.trust, "trusted");
	assert.equal(runtime.ui.children[0], runtime.transcriptViewport);
	assert.equal(runtime.ui.children.length, 6);
});

test("mycli shell runtime keeps the trust gate visible when persistence fails", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		requireTrust: true,
		onTrustSelect: async () => {
			throw new Error("private path details");
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\r");
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	assert.match(output, /Unable to save workspace trust/);
	assert.doesNotMatch(output, /private path details/);
	assert.match(output, /Project trust/);
	assert.equal(runtime.ui.children.length, 1);
});

test("mycli shell command palette replaces editor like coding-agent selector", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		commands: [slashCommand("trust", "/trust", "Review trust")],
	});

	runtime.start();
	await setTimeout(25);
	runtime.showCommandPalette();
	assert.equal(runtime.ui.children[3], runtime.editorContainer);
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /\/trust/);

	terminal.input?.("\x1b");
	await setTimeout(25);
	assert.equal(runtime.editorContainer.children[0], runtime.editor);
});

test("mycli shell approval selector replaces editor and submits selected choice", async () => {
	const terminal = new TestTerminal();
	const approvals: Array<[string, string, string | undefined, number | undefined]> = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingApproval: {
				decisionId: "decision-1",
				sessionId: "demo:sub:turn_1:abcd1234",
				generation: 7,
				preview: "file /tmp/image.jpg 2>&1",
				reason: "Shell command requires approval",
				toolName: "Bash",
				workerName: "explore",
				childSessionId: "demo:sub:turn_1:abcd1234",
				options: [
					{ choice: "approve_once", label: "Allow once" },
					{ choice: "reject", label: "Reject" },
				],
				risk: "medium",
				riskReason: "External command execution",
				diffPreview: "@@ -1 +1 @@\n-old\n+new",
			},
			footer: { ...sampleState().footer, liveState: "Waiting approval" },
		},
		terminal,
		onApprovalRespond: (decisionId, choice, approval) => {
			approvals.push([decisionId, choice, approval.sessionId, approval.generation]);
		},
	});

	runtime.start();
	await setTimeout(25);
	let output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Permission required · Bash · @explore/);
	assert.match(output, /demo:sub:turn_1:abcd1234/);
	assert.match(output, /⎿ file \/tmp\/image\.jpg 2>&1/);
	assert.doesNotMatch(output, /@@ -1 \+1 @@/);
	assert.match(output, /-old/);
	assert.match(output, /\+new/);
	assert.match(output, /→ 1\. Allow once/);
	assert.match(output, /1 allow\s+2 reject\s+↑↓ navigate\s+enter confirm\s+esc reject/);
	assert.doesNotMatch(output, /Approval required:/);
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.equal((output.match(/^─{10,}/gm) ?? []).length, 1);

	terminal.input?.("\x1b[B");
	await setTimeout(25);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /→ 2\. Reject/);

	terminal.input?.("\r");
	await setTimeout(25);
	assert.deepEqual(approvals, [["decision-1", "reject", "demo:sub:turn_1:abcd1234", 7]]);
});

test("mycli shell approval selector supports numeric and mnemonic shortcuts", async () => {
	const terminal = new TestTerminal();
	const approvals: Array<[string, string]> = [];
	const approvalState: MycliShellState = {
		...sampleState(),
		pendingApproval: {
			decisionId: "decision-3",
			preview: "python script.py",
			options: [
				{ choice: "approve_once", label: "Allow once" },
				{ choice: "reject", label: "Reject" },
			],
		},
		footer: { ...sampleState().footer, liveState: "Waiting approval" },
	};
	const runtime = new MycliShellRuntime({
		initialState: approvalState,
		terminal,
		onApprovalRespond: (decisionId, choice) => {
			approvals.push([decisionId, choice]);
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("1");
	await setTimeout(25);
	terminal.input?.("n");
	await setTimeout(25);

	assert.deepEqual(approvals, [["decision-3", "approve_once"]]);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Approved\./);
});

test("mycli shell approval selector restores choices after a rejected response", async () => {
	const terminal = new TestTerminal();
	const approvals: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingApproval: {
				decisionId: "decision-retry",
				sessionId: "child-session",
				generation: 3,
				preview: "sort package.json",
				options: [
					{ choice: "approve_once", label: "Allow once" },
					{ choice: "reject", label: "Reject" },
				],
			},
			footer: { ...sampleState().footer, liveState: "Waiting approval" },
		},
		terminal,
		onApprovalRespond: async (_decisionId, choice) => {
			approvals.push(choice);
			throw new Error("A turn is already running.");
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("1");
	await setTimeout(25);
	let output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.deepEqual(approvals, ["approve_once"]);
	assert.match(output, /A turn is already running\./);
	assert.match(output, /1\. Allow once/);
	assert.doesNotMatch(output, /Approved\.|Submitting\.\.\./);

	terminal.input?.("2");
	await setTimeout(25);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.deepEqual(approvals, ["approve_once", "reject"]);
	assert.match(output, /2\. Reject/);
});

test("mycli shell approval selector uses stable shortcuts for session and always allow", async () => {
	for (const [key, expected] of [
		["3", "allow_session"],
		["4", "always_allow"],
	] as const) {
		const terminal = new TestTerminal();
		const approvals: Array<[string, string]> = [];
		const runtime = new MycliShellRuntime({
			initialState: {
				...sampleState(),
				pendingApproval: {
					decisionId: `decision-${key}`,
					preview: "python -m pytest -q",
					persistentRulePreview: '["python", "-m", "pytest"]',
					options: [
						{ choice: "approve_once", label: "Allow once" },
						{ choice: "reject", label: "Reject" },
						{ choice: "allow_session", label: "Allow for session" },
						{ choice: "always_allow", label: "Always allow" },
					],
				},
				footer: { ...sampleState().footer, liveState: "Waiting approval" },
			},
			terminal,
			onApprovalRespond: (decisionId, choice) => {
				approvals.push([decisionId, choice]);
			},
		});

		runtime.start();
		await setTimeout(25);
		const output = stripAnsi(runtime.ui.render(100).join("\n"));
		assert.match(output, /4\. Always allow/);
		assert.match(output, /Always allow: \["python", "-m", "pytest"\]/);

		terminal.input?.(key);
		await setTimeout(25);
		assert.deepEqual(approvals, [[`decision-${key}`, expected]]);
	}
});

test("mycli shell approval selector does not derive shortcut four from option order", async () => {
	const terminal = new TestTerminal();
	const approvals: Array<[string, string]> = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingApproval: {
				decisionId: "decision-4",
				preview: "python -m pytest",
				options: [
					{ choice: "approve_once", label: "Allow once" },
					{ choice: "reject", label: "Reject" },
					{ choice: "always_allow", label: "Always allow" },
				],
			},
			footer: { ...sampleState().footer, liveState: "Waiting approval" },
		},
		terminal,
		onApprovalRespond: (decisionId, choice) => {
			approvals.push([decisionId, choice]);
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("4");
	await setTimeout(25);

	assert.deepEqual(approvals, [["decision-4", "always_allow"]]);
});

test("mycli shell approval selector maps escape to reject and stays mounted until backend clears it", async () => {
	const terminal = new TestTerminal();
	const approvals: Array<[string, string]> = [];
	const approvalState: MycliShellState = {
		...sampleState(),
		pendingApproval: {
			decisionId: "decision-2",
			preview: "rm generated.tmp",
			options: [
				{ choice: "approve_once", label: "Allow once" },
				{ choice: "reject", label: "Reject" },
			],
		},
		footer: { ...sampleState().footer, liveState: "Waiting approval" },
	};
	const runtime = new MycliShellRuntime({
		initialState: approvalState,
		terminal,
		onApprovalRespond: (decisionId, choice) => {
			approvals.push([decisionId, choice]);
		},
	});

	runtime.start();
	await setTimeout(25);
	const selector = runtime.editorContainer.children[0];
	assert.notEqual(selector, runtime.editor);

	terminal.input?.("\x1b");
	await setTimeout(25);
	assert.deepEqual(approvals, [["decision-2", "reject"]]);
	assert.equal(runtime.editorContainer.children[0], selector);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Rejected\./);

	runtime.setState({ ...approvalState, pendingApproval: undefined, pendingNotice: undefined, footer: { ...approvalState.footer, liveState: "Idle" } });
	assert.equal(runtime.editorContainer.children[0], runtime.editor);
});

test("mycli shell clarification selector submits a selected option", async () => {
	const terminal = new TestTerminal();
	const responses: Array<[string, string]> = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingClarification: {
				requestId: "question-1",
				header: "Scope",
				question: "Which implementation should we use?",
				options: [
					{ label: "Runtime", description: "Runtime only" },
					{ label: "TUI", description: "Terminal UI" },
					{ label: "Other", description: "Custom answer" },
				],
				multiSelect: false,
			},
			footer: { ...sampleState().footer, liveState: "Waiting clarification" },
		},
		terminal,
		onClarificationRespond: (requestId, response) => {
			responses.push([requestId, response]);
		},
	});

	runtime.start();
	await setTimeout(25);
	let output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Scope/);
	assert.match(output, /Which implementation should we use\?/);
	assert.match(output, /→ 1\. Runtime\s+Runtime only/);
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);

	terminal.input?.("2");
	await setTimeout(25);

	assert.deepEqual(responses, [["question-1", "TUI"]]);
});

test("mycli shell clarification selector restores choices after a rejected response", async () => {
	const terminal = new TestTerminal();
	const responses: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingClarification: {
				requestId: "question-retry",
				sessionId: "child-session",
				generation: 3,
				question: "Which implementation should we use?",
				options: [{ label: "Runtime" }, { label: "TUI" }],
				multiSelect: false,
			},
			footer: { ...sampleState().footer, liveState: "Waiting clarification" },
		},
		terminal,
		onClarificationRespond: async (_requestId, response) => {
			responses.push(response);
			throw new Error("A turn is already running.");
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("1");
	await setTimeout(25);
	let output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.deepEqual(responses, ["Runtime"]);
	assert.match(output, /A turn is already running\./);
	assert.match(output, /1\. Runtime/);
	assert.doesNotMatch(output, /Answered:|Submitting\.\.\./);

	terminal.input?.("2");
	await setTimeout(25);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.deepEqual(responses, ["Runtime", "TUI"]);
	assert.match(output, /2\. TUI/);
});

test("mycli shell clarification selector accepts a custom answer", async () => {
	const terminal = new TestTerminal();
	const responses: Array<[string, string]> = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingClarification: {
				requestId: "question-other",
				question: "Which implementation should we use?",
				options: [
					{ label: "Runtime" },
					{ label: "TUI" },
					{ label: "Other", description: "Custom answer" },
				],
				multiSelect: false,
			},
			footer: { ...sampleState().footer, liveState: "Waiting clarification" },
		},
		terminal,
		onClarificationRespond: (requestId, response) => {
			responses.push([requestId, response]);
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("3");
	terminal.input?.("Use both layers");
	terminal.input?.("\r");
	await setTimeout(25);

	assert.deepEqual(responses, [["question-other", "Use both layers"]]);
});

test("mycli shell clarification selector supports multi-select", async () => {
	const terminal = new TestTerminal();
	const responses: Array<[string, string]> = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingClarification: {
				requestId: "question-multi",
				question: "Which layers should change?",
				options: [{ label: "Runtime" }, { label: "TUI" }, { label: "Other" }],
				multiSelect: true,
			},
			footer: { ...sampleState().footer, liveState: "Waiting clarification" },
		},
		terminal,
		onClarificationRespond: (requestId, response) => {
			responses.push([requestId, response]);
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.(" ");
	terminal.input?.("\x1b[B");
	terminal.input?.(" ");
	terminal.input?.("\r");
	await setTimeout(25);

	assert.deepEqual(responses, [["question-multi", "Runtime, TUI"]]);
});

test("mycli shell keeps slash editable and opens commands from question key", async () => {
	const slashTerminal = new TestTerminal();
	const slashRuntime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: slashTerminal,
		commands: [slashCommand("settings", "/settings", "Open settings")],
	});

	slashRuntime.start();
	await setTimeout(25);
	slashTerminal.input?.("/");
	await setTimeout(25);
	assert.equal(slashRuntime.editorContainer.children[0], slashRuntime.editor);
	assert.equal(slashRuntime.editor.getText(), "/");
	assert.match(stripAnsi(slashRuntime.ui.render(100).join("\n")), /\/settings/);

	const questionTerminal = new TestTerminal();
	const questionRuntime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: questionTerminal,
		commands: [slashCommand("settings", "/settings", "Open settings")],
	});

	questionRuntime.start();
	await setTimeout(25);
	questionTerminal.input?.("?");
	await setTimeout(25);
	assert.notEqual(questionRuntime.editorContainer.children[0], questionRuntime.editor);
	assert.match(stripAnsi(questionRuntime.ui.render(100).join("\n")), /\/settings/);
});

test("mycli shell palette uses only gateway command metadata", () => {
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
		commands: [
			slashCommand("usage", "/usage", "Show usage"),
			slashCommand("ps", "/ps", "Show terminals"),
		],
	});

	runtime.showCommandPalette();
	const output = stripAnsi(runtime.ui.render(100).join("\n"));

	assert.match(output, /\/usage/);
	assert.match(output, /\/ps/);
	assert.doesNotMatch(output, /\/status usage/);
	assert.doesNotMatch(output, /\/settings/);
});

test("mycli shell sends every registered or legacy slash input to gateway", async () => {
	const submitted: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
		commands: [slashCommand("settings", "/settings", "Open settings")],
		onCommandSubmit: async (command) => {
			submitted.push(command);
		},
	});

	await runtime.editor.onSubmit?.("/settings");
	await runtime.editor.onSubmit?.("/status usage");
	await runtime.editor.onSubmit?.("/does-not-exist");

	assert.deepEqual(submitted, ["/settings", "/status usage", "/does-not-exist"]);
});

test("mycli shell executes stable local client actions", async () => {
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
		commands: [slashCommand("settings", "/settings", "Open settings")],
	});

	await runtime.handleClientAction("open_settings", "");
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);

	await runtime.handleClientAction("unknown_action", "");
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /unknown action unknown_action/);
});

test("ctrl o globally toggles tool details and survives gateway state refreshes", () => {
	const terminal = new TestTerminal();
	const initial = expandedToolDetailState();
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	runtime.start();

	terminal.input?.("\x0f");
	assert.equal(runtime.getState().tools[0]?.expanded, false);
	assert.equal(runtime.getState().bash[0]?.expanded, false);
	assert.doesNotMatch(stripAnsi(runtime.ui.render(100).join("\n")), /└ Command:/);
	const collapsedTranscriptTool = runtime.getState().transcript?.[0];
	assert.equal(
		collapsedTranscriptTool?.kind === "tool"
			? collapsedTranscriptTool.tool.expanded
			: undefined,
		false,
	);

	const incoming = expandedToolDetailState();
	const newTool = { ...incoming.tools[0]!, id: "tool-new", expanded: true };
	runtime.setState({
		...incoming,
		tools: [...incoming.tools, newTool],
		transcript: [
			...(incoming.transcript ?? []),
			{ id: newTool.id, kind: "tool", tool: newTool },
		],
	});
	assert.deepEqual(runtime.getState().tools.map((tool) => tool.expanded), [false, false]);
	assert.equal(runtime.getState().bash[0]?.expanded, false);

	terminal.input?.("\x0f");
	assert.deepEqual(runtime.getState().tools.map((tool) => tool.expanded), [true, true]);
	assert.equal(runtime.getState().bash[0]?.expanded, true);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /└ Command:/);
});

test("ctrl o reflows native scrollback from the toggled transcript", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 6;
	const runtime = new MycliShellRuntime({
		initialState: expandedToolDetailState(),
		terminal,
	});
	runtime.start();
	await setTimeout(25);
	terminal.output = "";

	terminal.input?.("\x0f");
	await setTimeout(25);

	assert.match(terminal.output, /\x1b\[3J/);
	const collapsedOutput = stripAnsi(terminal.output);
	assert.match(collapsedOutput, /Read/);
	assert.doesNotMatch(collapsedOutput, /└ Command:/);

	terminal.output = "";
	terminal.input?.("\x0f");
	await setTimeout(25);

	assert.match(terminal.output, /\x1b\[3J/);
	assert.match(stripAnsi(terminal.output), /└ Command:/);
});

test("ctrl o does not toggle tool details while a selector owns input", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: expandedToolDetailState(),
		terminal,
		commands: [slashCommand("settings", "/settings", "Open settings")],
	});
	runtime.start();
	await runtime.handleClientAction("open_settings", "");

	terminal.input?.("\x0f");

	assert.equal(runtime.getState().tools[0]?.expanded, true);
	assert.equal(runtime.getState().bash[0]?.expanded, true);
});

test("mycli shell dispatches every remaining local client action", async () => {
	const paletteRuntime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
		commands: [slashCommand("usage", "/usage", "Show usage")],
	});
	await paletteRuntime.handleClientAction("open_command_palette", "");
	assert.notEqual(paletteRuntime.editorContainer.children[0], paletteRuntime.editor);
	assert.match(stripAnsi(paletteRuntime.ui.render(100).join("\n")), /\/usage/);

	const sessionRuntime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
	});
	await sessionRuntime.handleClientAction("start_new_session", "");
	assert.equal(sessionRuntime.getState().messages.length, 0);
	assert.equal(sessionRuntime.getState().footer.liveState, "New session");

	const detailsRuntime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
	});
	const wasExpanded = detailsRuntime.getState().tools[0]?.expanded ?? false;
	await detailsRuntime.handleClientAction("toggle_details", "");
	assert.equal(detailsRuntime.getState().tools[0]?.expanded, !wasExpanded);

	const trustRuntime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
	});
	await trustRuntime.handleClientAction("open_trust", "");
	assert.notEqual(trustRuntime.editorContainer.children[0], trustRuntime.editor);
	assert.match(stripAnsi(trustRuntime.ui.render(100).join("\n")), /Project trust/);

	let exited = false;
	const quitRuntime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
		onExit: () => {
			exited = true;
		},
	});
	quitRuntime.start();
	await quitRuntime.handleClientAction("quit", "");
	assert.equal(quitRuntime.isStarted(), false);
	assert.equal(exited, true);
});

test("mycli shell slash autocomplete accepts selected command with tab", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		commands: [slashCommand("settings", "/settings", "Open settings")],
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("/");
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /\/settings/);

	terminal.input?.("\t");
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "/settings ");
});

test("mycli shell slash autocomplete wins over tab follow-up while running", async () => {
	const followUps: string[] = [];
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
		},
		terminal,
		commands: [slashCommand("settings", "/settings", "Open settings")],
		onFollowUp: (text) => {
			followUps.push(text);
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("/");
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /\/settings/);

	terminal.input?.("\t");
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "/settings ");
	assert.deepEqual(followUps, []);
});

test("mycli shell slash autocomplete filters and submits with enter", async () => {
	const terminal = new TestTerminal();
	const commands: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		commands: [slashCommand("status", "/status", "Show status")],
		onCommandSubmit: (command) => {
			commands.push(command);
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("/sta");
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /\/status/);

	terminal.input?.("\r");
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "");
	assert.deepEqual(commands, ["/status"]);
});

test("mycli shell keeps slash as text when editor is not empty", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("a");
	terminal.input?.("/");
	await setTimeout(25);
	assert.equal(runtime.editorContainer.children[0], runtime.editor);
	assert.equal(runtime.editor.getText(), "a/");
});

test("mycli shell model selector opens from slash command and selects model", async () => {
	const terminal = new TestTerminal();
	let selected = "";
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onModelSelect: (model) => {
			selected = `${model.provider}/${model.model}/${model.thinkingLevel ?? ""}`;
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_model_selector", "");
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /deepseek-v4-flash/);

	terminal.input?.("\x1b[B");
	terminal.input?.("\r");
	terminal.input?.("\r");
	await setTimeout(25);
	assert.equal(runtime.editorContainer.children[0], runtime.editor);
	assert.equal(runtime.getState().footer.model, "gpt-5.4");
	assert.equal(runtime.getState().footer.provider, "openai");
	assert.equal(runtime.getState().footer.reasoningLevel, "medium");
	assert.equal(selected, "openai/gpt-5.4/medium");
});

test("mycli shell shows command inventory as a dismissible editor overlay", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	runtime.showCommandResultOverlay({
		id: "overlay:tools",
		display: {
			version: 1,
			kind: "list",
			command: "/tools",
			title: "Tools",
			severity: "info",
			fields: [],
			rows: [{ key: "Read", label: "Read", values: ["builtin", "file"] }],
			sections: [],
			suggestions: [],
			omittedRows: 0,
			omittedChars: 0,
		},
		fallbackLines: [],
		folded: false,
	});
	await setTimeout(25);

	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Tools[\s\S]*Read[\s\S]*builtin/);

	terminal.input?.("\x1b");
	await setTimeout(25);
	assert.equal(runtime.editorContainer.children[0], runtime.editor);
});

test("mycli shell login flow replaces editor with auth selectors", async () => {
	const terminal = new TestTerminal();
	const saved: Array<[string, string]> = [];
	let selected = "";
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onApiKeyLogin: async (providerId, apiKey) => {
			saved.push([providerId, apiKey]);
			return { message: `Saved API key for ${providerId}` };
		},
		onModelSelect: (model) => {
			selected = `${model.provider}/${model.model}/${model.thinkingLevel ?? ""}`;
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_login", "");

	let output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.match(output, /Select provider to configure:/);
	assert.match(output, /OpenAI • unconfigured/);
	assert.match(output, /DeepSeek • unconfigured/);
	assert.doesNotMatch(output, /default model/);

	terminal.input?.("deep");
	await setTimeout(25);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /DeepSeek • unconfigured/);
	assert.doesNotMatch(output, /OpenAI • unconfigured/);

	terminal.input?.("\r");
	await setTimeout(25);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Login to DeepSeek/);
	assert.match(output, /Enter API key:/);

	terminal.input?.("\x1b[200~sk-deepseek\x1b[201~");
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.doesNotMatch(output, /sk-deepseek/);
	assert.match(output, /•••••••••••/);
	terminal.input?.("\r");
	await setTimeout(25);

	assert.deepEqual(saved, [["deepseek", "sk-deepseek"]]);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.match(output, /deepseek-v4-flash\s+deepseek/);
	assert.doesNotMatch(output, /gpt-5.4\s+openai/);
	assert.match(output, /Saved API key for deepseek/);

	terminal.input?.("\r");
	await setTimeout(25);

	assert.equal(runtime.editorContainer.children[0], runtime.editor);
	assert.equal(selected, "deepseek/deepseek-v4-flash/");
});

test("mycli shell model selector can change thinking effort with model selection", async () => {
	const terminal = new TestTerminal();
	let selected = "";
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onModelSelect: (model) => {
			selected = `${model.provider}/${model.model}/${model.thinkingLevel ?? ""}`;
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_model_selector", "");
	terminal.input?.("\x1b[B");
	terminal.input?.("\r");
	let output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Select reasoning effort/);
	assert.match(output, /medium/);

	terminal.input?.("\x1b[B");
	terminal.input?.("\x1b[B");
	terminal.input?.("\r");
	await setTimeout(25);

	assert.equal(runtime.editorContainer.children[0], runtime.editor);
	assert.equal(runtime.getState().footer.reasoningLevel, "xhigh");
	assert.equal(selected, "openai/gpt-5.4/xhigh");
});

test("mycli shell keeps model selector open until backend selection succeeds", async () => {
	const terminal = new TestTerminal();
	let resolveSelection: (() => void) | undefined;
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onModelSelect: () => new Promise<void>((resolve) => {
			resolveSelection = resolve;
		}),
	});
	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_model_selector", "");

	terminal.input?.("\r");
	await setTimeout(10);
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);

	resolveSelection?.();
	await setTimeout(25);
	assert.equal(runtime.editorContainer.children[0], runtime.editor);
});

test("mycli shell keeps model selector open and shows backend selection errors", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onModelSelect: async () => {
			throw new Error("Provider rejected this model.");
		},
	});
	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_model_selector", "");

	terminal.input?.("\r");
	await setTimeout(25);

	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Provider rejected this model/);
	assert.equal(runtime.getState().footer.model, "deepseek-v4-flash");
});

test("mycli shell model selector opens from app model keybinding", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\f");
	await setTimeout(25);
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /deepseek-v4-flash/);
});

test("mycli shell settings selector persists visual settings through runtime callback", async () => {
	const terminal = new TestTerminal();
	const savedSettings: MycliShellState["settings"][] = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSettingsChange: async (settings) => {
			savedSettings.push(settings);
			return { ...settings, statusbarMode: "compact" };
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_settings", "");
	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Settings/);
	assert.match(output, /Statusbar/);

	terminal.input?.("\x1b[B");
	terminal.input?.("\x1b[B");
	terminal.input?.("\x1b[B");
	terminal.input?.(" ");
	await setTimeout(25);
	assert.equal(savedSettings.at(-1)?.hideThinking, false);
	assert.equal(runtime.getState().settings?.hideThinking, false);
	assert.equal(runtime.getState().settings?.statusbarMode, "compact");
});

test("mycli shell session selector handles empty state and selection", async () => {
	const emptyTerminal = new TestTerminal();
	const emptyRuntime = new MycliShellRuntime({
		initialState: { ...sampleState(), sessions: [] },
		terminal: emptyTerminal,
	});

	emptyRuntime.start();
	await setTimeout(25);
	emptyRuntime.showSessionSelector();
	assert.match(stripAnsi(emptyRuntime.ui.render(100).join("\n")), /No sessions available/);

	const terminal = new TestTerminal();
	let selected = "";
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSessionSelect: (sessionId) => {
			selected = sessionId;
		},
	});
	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_session_selector", "");
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Session A/);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Scope: current/);
	terminal.input?.("cache");
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /No matching sessions/);
	terminal.input?.("\t");
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Session B/);
	terminal.input?.("\x1b[B");
	terminal.input?.("\r");
	await setTimeout(25);
	assert.equal(selected, "session-b");
	assert.equal(runtime.getState().footer.sessionName, "session-b");
});

test("mycli shell session selection replaces native scrollback with loaded history once", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 16;
	let runtime: MycliShellRuntime;
	runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSessionSelect: async (sessionId) => {
			const messages = Array.from({ length: 30 }, (_, index) => ({
				id: `resumed-${index}`,
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				text: `resumed history ${index}`,
			}));
			runtime.setState({
				...runtime.getState(),
				messages,
				tools: [],
				bash: [],
				transcript: undefined,
				footer: { ...runtime.getState().footer, sessionName: sessionId },
			});
		},
	});

	runtime.start();
	await setTimeout(25);
	runtime.showSessionSelector();
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(terminal.columns).join("\n")), /Resume Session/);
	terminal.output = "";

	terminal.input?.("\r");
	await setTimeout(50);

	const output = stripAnsi(terminal.output);
	const oldestHistory = output.indexOf("resumed history 0");
	const header = output.indexOf("mycli ctrl+p commands");
	const visibleTail = output.indexOf("resumed history 29");
	assert.ok(oldestHistory >= 0);
	assert.ok(header >= 0);
	assert.ok(oldestHistory > header);
	assert.ok(visibleTail > oldestHistory);
	assert.equal(output.match(/mycli ctrl\+p commands/g)?.length, 1);
	for (let index = 0; index < 30; index += 1) {
		assert.equal(
			output.match(new RegExp(`resumed history ${index}(?!\\d)`, "g"))?.length,
			1,
			`resumed history ${index} should render once`,
		);
	}
	assert.doesNotMatch(output, /Resume Session/);
	assert.match(terminal.output, /\x1b\[3J/);
});

test("cross-session state replacement writes history once without changing messages", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 12;
	const destination = [
		{ id: "same-text-1", role: "user" as const, text: "legitimate repeat" },
		{ id: "same-text-2", role: "user" as const, text: "legitimate repeat" },
		...Array.from({ length: 20 }, (_, index) => ({
			id: `destination-${index}`,
			role: "assistant" as const,
			text: `destination history ${index}`,
		})),
	];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.output = "";
	runtime.replaceSessionState({
		...runtime.getState(),
		messages: destination,
		tools: [],
		bash: [],
		transcript: undefined,
		footer: { ...runtime.getState().footer, sessionName: "destination" },
	});
	await setTimeout(50);

	assert.equal(terminal.output.match(/\x1b\[3J/g)?.length, 1);
	assert.equal(
		stripAnsi(terminal.output).match(/destination history 0/g)?.length,
		1,
	);
	assert.deepEqual(runtime.getState().messages.slice(0, 2), destination.slice(0, 2));
});

test("mycli shell keeps the session selector mounted until resume history is ready", async () => {
	const terminal = new TestTerminal();
	let releaseLoad: (() => void) | undefined;
	const load = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSessionSelect: async () => load,
	});

	runtime.start();
	await setTimeout(25);
	runtime.showSessionSelector();
	await setTimeout(25);
	terminal.input?.("\r");
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(terminal.columns).join("\n")), /Resume Session/);

	releaseLoad?.();
	await setTimeout(25);
	assert.doesNotMatch(stripAnsi(runtime.ui.render(terminal.columns).join("\n")), /Resume Session/);
});

test("mycli shell resource selector loads resources and opens runtime inspect command", async () => {
	const terminal = new TestTerminal();
	const commands: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onResourceLoad: async () => sampleState().resources ?? [],
		onCommandSubmit: async (command) => {
			commands.push(command);
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.handleClientAction("open_resources", "");
	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Resources/);
	assert.match(output, /configured:repo:post-tool/);

	terminal.input?.("\r");
	await setTimeout(25);
	assert.deepEqual(commands, ["/tools hooks"]);
});

test("mycli shell session tree selector filters folds and selects nodes", async () => {
	const terminal = new TestTerminal();
	let selected = "";
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSessionTreeLoad: async () => ({
			sessionId: "session-a",
			activePath: ["session-a"],
			nodes: [
				{
					id: "session:session-a",
					kind: "session",
					sessionId: "session-a",
					depth: 0,
					role: "session",
					summary: "Session A",
					messageCount: 2,
					active: true,
					onActivePath: true,
					preview: "Inspect package.json\nDone",
				},
				{
					id: "session:session-a:message:0",
					kind: "message",
					sessionId: "session-a",
					parentId: "session:session-a",
					depth: 1,
					role: "user",
					summary: "Inspect package.json",
					messageIndex: 0,
					onActivePath: true,
					preview: "Inspect package.json",
				},
				{
					id: "session:session-a:message:1",
					kind: "message",
					sessionId: "session-a",
					parentId: "session:session-a",
					depth: 1,
					role: "assistant",
					summary: "Done",
					messageIndex: 1,
					onActivePath: true,
					preview: "Done",
				},
			],
		}),
		onSessionTreeSelect: (node) => {
			selected = node.id;
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.showSessionTreeSelector();
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Conversation Tree/);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Session A/);

	terminal.input?.("package");
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Inspect package\.json/);
	assert.doesNotMatch(stripAnsi(runtime.ui.render(100).join("\n")), /Done/);

	terminal.input?.("\r");
	await setTimeout(25);
	assert.equal(selected, "session:session-a");
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Selected Session A/);
});

test("mycli shell session tree selection jumps to matching transcript anchor", async () => {
	const terminal = new TestTerminal();
	terminal.rows = 12;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 20 }, (_, index) => ({
				id: `m${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
		},
		terminal,
		onSessionTreeLoad: async () => ({
			sessionId: "session-a",
			activePath: ["session-a"],
			nodes: [
				{
					id: "session:session-a:message:2",
					kind: "message",
					sessionId: "session-a",
					depth: 1,
					role: "user",
					summary: "message 2",
					messageIndex: 2,
					anchorId: "m2",
					preview: "message 2",
				},
			],
		}),
	});
	runtime.start();
	await setTimeout(25);
	assert.match(stripAnsi(terminal.output), /message 19/);

	await runtime.showSessionTreeSelector();
	terminal.input?.("\r");
	await setTimeout(25);

	assert.ok(runtime.getTranscriptScrollOffset() > 0);
	assert.equal(
		runtime.getState().transcript?.some((block) => block.kind === "message" && block.message.text === "Jumped to message 2"),
		true,
	);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /message 2/);
});

test("mycli shell runtime submits messages and local slash commands", async () => {
	const terminal = new TestTerminal();
	const submitted: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: (text) => {
			submitted.push(text);
		},
	});

	runtime.editor.setText("hello");
	await runtime.editor.onSubmit?.("hello");
	assert.deepEqual(submitted, ["hello"]);
	assert.equal(runtime.editor.getText(), "");

	await runtime.handleClientAction("clear_transcript", "");
	assert.equal(runtime.getState().messages.length, 0);
	assert.equal(runtime.getState().tools.length, 0);
	assert.equal(runtime.getState().transcript?.length, 0);
});

test("mycli shell runtime contains asynchronous submit failures at the editor boundary", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: async () => {
			throw new Error("submit failed");
		},
	});

	runtime.start();
	await setTimeout(25);
	runtime.editor.setText("hello");
	terminal.input?.("\r");
	await setTimeout(25);

	assert.equal(runtime.isStarted(), true);
	assert.equal(runtime.editor.getText(), "hello");
	assert.equal(runtime.getState().transcript?.some((block) =>
		block.kind === "message"
			&& block.message.role === "system"
			&& block.message.text === "Message submission failed: submit failed"
	), true);
	runtime.ui.stop();
});

test("mycli shell runtime contains follow-up failures and restores the queued input", async () => {
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
		},
		terminal: new TestTerminal(),
		onFollowUp: async () => {
			throw new Error("follow-up failed");
		},
	});

	runtime.editor.setText("keep this follow-up");
	runtime.editor.actionHandlers.get("app.message.followUp")?.();
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "keep this follow-up");
	assert.equal(runtime.getState().transcript?.some((block) =>
		block.kind === "message"
			&& block.message.role === "system"
			&& block.message.text === "Follow-up submission failed: follow-up failed"
	), true);
});

test("mycli shell runtime submits local image attachments from @image paths", async () => {
	const terminal = new TestTerminal();
	const submitted: Array<{ text: string; images: string[] }> = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: (text, attachments) => {
			submitted.push({ text, images: attachments?.localImages?.map((image) => image.path) ?? [] });
		},
	});

	runtime.editor.setText("describe @/tmp/screenshot.JPEG and @/tmp/diagram.gif please");
	await runtime.editor.onSubmit?.("describe @/tmp/screenshot.JPEG and @/tmp/diagram.gif please");

	assert.deepEqual(submitted, [
		{ text: "describe [image #1] and [image #2] please", images: ["/tmp/screenshot.JPEG", "/tmp/diagram.gif"] },
	]);
	assert.equal(runtime.editor.getText(), "");
});

test("mycli shell runtime normalizes dropped workspace file paths in editor", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
	});
	runtime.start();

	terminal.input?.(`\x1b[200~${join(process.cwd(), "src/app.ts")}\x1b[201~`);

	assert.equal(runtime.editor.getText(), "@src/app.ts");
});

test("mycli shell runtime turns dropped workspace image files into attachments", async () => {
	const terminal = new TestTerminal();
	const submitted: Array<{ text: string; images: string[] }> = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: (text, attachments) => {
			submitted.push({ text, images: attachments?.localImages?.map((image) => image.path) ?? [] });
		},
	});
	runtime.start();

	terminal.input?.(`\x1b[200~${join(process.cwd(), "assets/screen.webp")}\x1b[201~`);

	assert.equal(runtime.editor.getText(), "[image #1]");

	await runtime.editor.onSubmit?.("describe [image #1]");

	assert.deepEqual(submitted, [{ text: "describe [image #1]", images: ["assets/screen.webp"] }]);
	assert.equal(runtime.editor.getText(), "");
});

test("mycli shell runtime separates dropped image placeholders from preceding words", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
	});
	runtime.start();
	runtime.editor.setText("describe");

	terminal.input?.(`\x1b[200~${join(process.cwd(), "assets/screen.png")}\x1b[201~`);

	assert.equal(runtime.editor.getText(), "describe [image #1]");
});

test("mycli shell runtime promotes plain absolute image path input into attachments", async () => {
	const terminal = new TestTerminal();
	const submitted: Array<{ text: string; images: string[] }> = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: (text, attachments) => {
			submitted.push({ text, images: attachments?.localImages?.map((image) => image.path) ?? [] });
		},
	});
	runtime.start();

	runtime.editor.setText("/Users/cosmos/Desktop/qq_emoji_image.jpg");

	assert.equal(runtime.editor.getText(), "[image #1]");

	await runtime.editor.onSubmit?.("[image #1]");

	assert.deepEqual(submitted, [
		{ text: "[image #1]", images: ["/Users/cosmos/Desktop/qq_emoji_image.jpg"] },
	]);
});

test("mycli shell runtime promotes terminal absolute image path input into attachments", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
	});
	runtime.start();

	terminal.input?.("/Users/cosmos/Desktop/qq_emoji_image.jpg");

	assert.equal(runtime.editor.getText(), "[image #1]");
});

test("mycli shell runtime keeps dropped image attachments when submitting with enter", async () => {
	const terminal = new TestTerminal();
	const submitted: Array<{ text: string; images: string[] }> = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: (text, attachments) => {
			submitted.push({ text, images: attachments?.localImages?.map((image) => image.path) ?? [] });
		},
	});
	runtime.start();

	terminal.input?.("/Users/cosmos/Desktop/qq_emoji_image.jpg");
	terminal.input?.("这张图是什么内容");
	terminal.input?.("\r");

	assert.deepEqual(submitted, [
		{
			text: "[image #1]这张图是什么内容",
			images: ["/Users/cosmos/Desktop/qq_emoji_image.jpg"],
		},
	]);
});

test("mycli shell editor treats image placeholders as atomic colored markers", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
	});
	runtime.start();

	terminal.input?.("/Users/cosmos/Desktop/qq_emoji_image.jpg");
	terminal.input?.("x");

	assert.equal(runtime.editor.getText(), "[image #1]x");
	assert.match(stripAnsi(runtime.editorContainer.render(100).join("\n")), /\[image #1\]x/);

	terminal.input?.("\x1b[D");
	assert.deepEqual(runtime.editor.getCursor(), { line: 0, col: "[image #1]".length });

	terminal.input?.("\x1b[D");
	assert.deepEqual(runtime.editor.getCursor(), { line: 0, col: 0 });

	terminal.input?.("\x1b[C");
	assert.deepEqual(runtime.editor.getCursor(), { line: 0, col: "[image #1]".length });

	terminal.input?.("\b");
	assert.equal(runtime.editor.getText(), "x");
});

test("editor renders image placeholders through marker styling", () => {
	const terminal = new TestTerminal();
	const editor = new Editor(
		{ terminal, requestRender: () => undefined } as never,
		{
			borderColor: (text) => text,
			imageMarker: (text) => `<image>${text}</image>`,
			selectList: {
				selectedPrefix: (text) => text,
				selectedText: (text) => text,
				description: (text) => text,
				scrollInfo: (text) => text,
				noMatch: (text) => text,
			},
		},
	);
	editor.setText("[image #1] hello");

	assert.match(editor.render(80).join("\n"), /<image>\[image #1\]<\/image> hello/);
});

test("mycli shell runtime ignores dropped image attachments after placeholder deletion", async () => {
	const terminal = new TestTerminal();
	const submitted: Array<{ text: string; images: string[] }> = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: (text, attachments) => {
			submitted.push({ text, images: attachments?.localImages?.map((image) => image.path) ?? [] });
		},
	});
	runtime.start();

	terminal.input?.(`\x1b[200~${join(process.cwd(), "assets/screen.png")}\x1b[201~`);
	runtime.editor.setText("describe without image");

	await runtime.editor.onSubmit?.("describe without image");

	assert.deepEqual(submitted, [{ text: "describe without image", images: [] }]);
});

test("mycli shell runtime forwards running-turn messages for steering queueing", async () => {
	const submitted: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
		},
		terminal: new TestTerminal(),
		onSubmit: (text) => {
			submitted.push(text);
		},
	});

	runtime.editor.setText("second turn");
	await runtime.editor.onSubmit?.("second turn");

	assert.deepEqual(submitted, ["second turn"]);
	assert.equal(runtime.editor.getText(), "");
});

test("mycli shell runtime queues follow-up messages with tab while running", async () => {
	const followUps: string[] = [];
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
		},
		terminal,
		onFollowUp: (text) => {
			followUps.push(text);
		},
	});

	runtime.start();
	await setTimeout(25);
	runtime.editor.setText("after current run");
	terminal.input?.("\t");
	await setTimeout(25);

	assert.deepEqual(followUps, ["after current run"]);
	assert.equal(runtime.editor.getText(), "");
});

test("mycli shell runtime queues follow-up image attachments with tab while running", async () => {
	const followUps: Array<{ text: string; images: string[] }> = [];
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
		},
		terminal,
		onFollowUp: (text, attachments) => {
			followUps.push({
				text,
				images: attachments?.localImages?.map((image) => image.path) ?? [],
			});
		},
	});

	runtime.start();
	await setTimeout(25);
	runtime.editor.setText("@/tmp/follow.png summarize after current run");
	terminal.input?.("\t");
	await setTimeout(25);

	assert.deepEqual(followUps, [
		{ text: "[image #1] summarize after current run", images: ["/tmp/follow.png"] },
	]);
	assert.equal(runtime.editor.getText(), "");
});

test("mycli shell runtime restores queued messages with alt up", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingInput: {
				pendingSteers: [{ text: "keep steering", hasImages: false }],
				rejectedSteers: [],
				followUps: [{ text: "older follow-up", hasImages: false }],
			},
		},
		terminal,
		onDequeueQueuedInput: () => "queued follow-up",
	});

	runtime.start();
	await setTimeout(25);
	runtime.editor.setText("draft");
	terminal.input?.("\x1bp");
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "queued follow-up\n\ndraft");
	const output = stripAnsi(runtime.pendingMessagesContainer.render(100).join("\n"));
	assert.match(output, /↳ keep steering/);
	assert.match(output, /↳ older follow-up/);
	assert.doesNotMatch(output, /↳ queued follow-up/);
});

test("mycli shell runtime restores queued messages with shift left", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingInput: {
				pendingSteers: [{ text: "keep steering", hasImages: false }],
				rejectedSteers: [],
				followUps: [{ text: "older follow-up", hasImages: false }],
			},
		},
		terminal,
		onDequeueQueuedInput: () => "queued follow-up",
	});

	runtime.start();
	await setTimeout(25);
	runtime.editor.setText("draft");
	terminal.input?.("\x1b[d");
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "queued follow-up\n\ndraft");
	const output = stripAnsi(runtime.pendingMessagesContainer.render(100).join("\n"));
	assert.match(output, /↳ keep steering/);
	assert.match(output, /↳ older follow-up/);
});

test("mycli shell runtime restores queued image attachments with alt up", async () => {
	const submitted: Array<{ text: string; images: string[] }> = [];
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingInput: {
				pendingSteers: [{ text: "keep steering", hasImages: false }],
				rejectedSteers: [],
				followUps: [{ text: "older image follow-up", hasImages: true }],
			},
		},
		terminal,
		onDequeueQueuedInput: () => ({
			text: "[image #1] queued image",
			localImages: [{ path: "/tmp/queued.png", placeholder: "[image #1]" }],
		}),
		onSubmit: (text, attachments) => {
			submitted.push({
				text,
				images: attachments?.localImages?.map((image) => image.path) ?? [],
			});
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\x1bp");
	await setTimeout(25);
	await runtime.editor.onSubmit?.(runtime.editor.getText());

	assert.deepEqual(submitted, [{ text: "[image #1] queued image", images: ["/tmp/queued.png"] }]);
	assert.equal(runtime.editor.getText(), "");
	assert.match(stripAnsi(runtime.pendingMessagesContainer.render(100).join("\n")), /↳ older image follow-up/);
});

test("mycli shell runtime interrupts running turns with ctrl c and restores submitted input", async () => {
	let interrupted = 0;
	let rollbackUserInput = false;
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: () => undefined,
		onInterrupt: (options) => {
			interrupted += 1;
			rollbackUserInput = options.rollbackUserInput;
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.editor.onSubmit?.("draft before send");
	runtime.setState({
		...runtime.getState(),
		footer: { ...runtime.getState().footer, liveState: "Running" },
	});
	terminal.input?.("\x03");
	await setTimeout(25);

	assert.equal(interrupted, 1);
	assert.equal(rollbackUserInput, true);
	assert.equal(runtime.editor.getText(), "");
	runtime.completeInterruptedTurn([]);
	assert.equal(runtime.editor.getText(), "draft before send");
	assert.doesNotMatch(stripAnsi(runtime.ui.render(100).join("\n")), /Interrupt requested/);
});

test("mycli shell runtime removes restored interrupted submit from prompt history", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: () => undefined,
		onInterrupt: () => undefined,
	});

	runtime.start();
	await setTimeout(25);
	await runtime.editor.onSubmit?.("older prompt");
	runtime.setState({
		...runtime.getState(),
		footer: { ...runtime.getState().footer, liveState: "Running" },
	});
	runtime.setState({
		...runtime.getState(),
		footer: { ...runtime.getState().footer, liveState: "Completed" },
	});
	await runtime.editor.onSubmit?.("interrupted prompt");
	runtime.setState({
		...runtime.getState(),
		footer: { ...runtime.getState().footer, liveState: "Running" },
	});
	terminal.input?.("\x03");
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "");
	runtime.completeInterruptedTurn([]);
	assert.equal(runtime.editor.getText(), "interrupted prompt");
	runtime.editor.setText("");
	runtime.editor.handleInput("\x1b[A");
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "older prompt");
});

test("mycli shell does not restore an interrupted prompt after visible agent activity", async () => {
	let rollbackUserInput = true;
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: () => undefined,
		onInterrupt: (options) => {
			rollbackUserInput = options.rollbackUserInput;
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.editor.onSubmit?.("do some work");
	runtime.setState({
		...runtime.getState(),
		messages: [
			...runtime.getState().messages,
			{ id: "visible-agent-output", role: "assistant", text: "Starting now." },
		],
		transcript: [
			...(runtime.getState().transcript ?? []),
			{
				id: "visible-agent-output",
				kind: "message",
				message: { id: "visible-agent-output", role: "assistant", text: "Starting now." },
			},
		],
		footer: { ...runtime.getState().footer, liveState: "Running" },
	});
	terminal.input?.("\x1b");
	await setTimeout(25);
	runtime.completeInterruptedTurn([]);

	assert.equal(runtime.editor.getText(), "");
	assert.equal(rollbackUserInput, false);
});

test("mycli shell does not restore submitted input when backend denies rollback", async () => {
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
		onSubmit: () => undefined,
	});

	runtime.start();
	await setTimeout(25);
	await runtime.editor.onSubmit?.("keep this turn persisted");
	runtime.setState({
		...runtime.getState(),
		footer: { ...runtime.getState().footer, liveState: "Running" },
	});

	runtime.completeInterruptedTurn([], { restoreSubmittedInput: false });

	assert.equal(runtime.editor.getText(), "");
});

test("mycli shell does not render an interrupt notice when the backend rejects the request", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
		},
		terminal,
		onInterrupt: () => false,
	});
	runtime.start();
	await setTimeout(25);
	terminal.input?.("\x03");
	await setTimeout(25);

	assert.doesNotMatch(stripAnsi(runtime.ui.render(100).join("\n")), /Interrupt requested/);
});

test("mycli shell uses the force-exit callback on repeated ctrl c after interruption", async () => {
	let forceExits = 0;
	const terminal = new TestTerminal();
	let runtime!: MycliShellRuntime;
	runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
		},
		terminal,
		onInterrupt: () => {
			runtime.setState({
				...runtime.getState(),
				footer: {
					...runtime.getState().footer,
					liveState: "Interrupted",
					liveStateKind: "interrupted",
				},
			});
			return true;
		},
		onInterruptExit: () => { forceExits += 1; },
	});
	runtime.start();
	await setTimeout(25);
	terminal.input?.("\x03");
	await setTimeout(25);
	terminal.input?.("\x03");
	await setTimeout(25);

	assert.equal(forceExits, 1);
});

test("mycli shell allows a second ctrl c while interrupt confirmation is pending", async () => {
	let forceExits = 0;
	let resolveInterrupt!: () => void;
	const interruptPending = new Promise<void>((resolve) => { resolveInterrupt = resolve; });
	const terminal = new TestTerminal();
	let runtime!: MycliShellRuntime;
	runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
		},
		terminal,
		onInterrupt: () => {
			runtime.setState({
				...runtime.getState(),
				footer: {
					...runtime.getState().footer,
					liveState: "Interrupting",
					liveStateKind: "interrupting",
				},
			});
			return interruptPending;
		},
		onInterruptExit: () => { forceExits += 1; },
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\x03");
	await setTimeout(10);
	terminal.input?.("\x03");
	await setTimeout(25);

	assert.equal(forceExits, 1);
	resolveInterrupt();
});

test("mycli shell restores interrupted queued inputs in order with attachments", () => {
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
	});

	runtime.completeInterruptedTurn([
		{ text: "first queued" },
		{
			text: "[image #1] second queued",
			localImages: [{ path: "/tmp/queued.png", placeholder: "[image #1]" }],
		},
	]);

	assert.equal(runtime.editor.getText(), "first queued\n\n[image #1] second queued");
});

test("mycli shell renders reconnect details and keeps the turn interruptible", async () => {
	let interrupted = 0;
	const terminal = new TestTerminal();
	terminal.columns = 44;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: [{ id: "retry-user", role: "user", text: "retry this request" }],
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
			footer: {
				...sampleState().footer,
				liveState: "Reconnecting... 1/5",
				liveStateKind: "reconnecting",
				liveStateDetail: "Idle timeout waiting for model stream",
			},
		},
		terminal,
		onInterrupt: () => {
			interrupted += 1;
		},
	});

	runtime.start();
	await setTimeout(25);
	const lines = runtime.ui.render(terminal.columns);
	const output = stripAnsi(lines.join("\n"));
	assert.match(output, /Reconnecting\.\.\. 1\/5/);
	assert.match(output.replace(/\s+/g, " "), /Idle timeout waiting for model stream/);
	const retryLines = lines.filter((line) => /Reconnecting|Idle timeout|model stream/.test(stripAnsi(line)));
	for (const line of retryLines) {
		assert.ok(visibleWidth(line) <= terminal.columns, `line exceeded terminal width: ${stripAnsi(line)}`);
	}

	terminal.input?.("\x1b");
	await setTimeout(25);
	assert.equal(interrupted, 1);
	runtime.ui.stop();
});

test("mycli shell runtime interrupts running turns with escape", async () => {
	let interrupted = 0;
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
			pendingInput: {
				pendingSteers: [{ text: "keep steering", hasImages: false }],
				rejectedSteers: [],
				followUps: [{ text: "keep follow-up", hasImages: false }],
			},
		},
		terminal,
		onInterrupt: () => {
			interrupted += 1;
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\x1b");
	await setTimeout(25);

	assert.equal(interrupted, 1);
	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.doesNotMatch(output, /Interrupt requested/);
	assert.match(output, /↳ keep steering/);
	assert.match(output, /↳ keep follow-up/);
});

test("mycli shell runtime clears editor then exits on repeated ctrl c while idle", async () => {
	let now = 1000;
	let exits = 0;
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		now: () => now,
		onExit: () => {
			exits += 1;
		},
	});

	runtime.start();
	await setTimeout(25);
	runtime.editor.setText("draft");
	terminal.input?.("\x03");
	await setTimeout(25);
	assert.equal(runtime.editor.getText(), "");
	assert.equal(exits, 0);

	terminal.input?.("\x03");
	await setTimeout(25);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Press Ctrl\+C again to exit/);
	assert.equal(exits, 0);

	now = 1500;
	terminal.input?.("\x03");
	await setTimeout(25);
	assert.equal(exits, 1);
	assert.equal(runtime.isStarted(), false);
});

test("mycli shell forwards backend slash commands instead of chatting them", async () => {
	const submitted: string[] = [];
	const commands: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
		onSubmit: (text) => {
			submitted.push(text);
		},
		onCommandSubmit: (command) => {
			commands.push(command);
		},
	});

	await runtime.editor.onSubmit?.("/changes");
	await runtime.editor.onSubmit?.("/tasks agents child-session");
	await runtime.editor.onSubmit?.("/trace export");
	await runtime.editor.onSubmit?.("/memroy");
	await runtime.editor.onSubmit?.("/Users/cosmos/Desktop/demo 帮我在这个文件夹下新建一个文件夹，叫做game");

	assert.deepEqual(submitted, ["/Users/cosmos/Desktop/demo 帮我在这个文件夹下新建一个文件夹，叫做game"]);
	assert.deepEqual(commands, ["/changes", "/tasks agents child-session", "/trace export", "/memroy"]);
});

test("mycli shell cycles collaboration mode with shift tab", async () => {
	const commands: string[] = [];
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onCommandSubmit: (command) => {
			commands.push(command);
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\x1b[Z");
	await setTimeout(25);
	runtime.setState({
		...runtime.getState(),
		footer: { ...runtime.getState().footer, collaborationMode: "plan" },
	});
	terminal.input?.("\x1b[Z");
	await setTimeout(25);

	assert.deepEqual(commands, ["/mode plan", "/mode default"]);
});

test("mycli shell opens permissions with ctrl x", async () => {
	const commands: string[] = [];
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			permissions: {
				active: "workspace",
				commandAllowanceCount: 0,
				profiles: [
					{
						id: "workspace",
						label: "Ask for approval",
						description: "Workspace access with approval.",
						current: true,
					},
				],
			},
		},
		terminal,
		onCommandSubmit: (command) => {
			commands.push(command);
		},
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\x18");
	await setTimeout(25);

	assert.deepEqual(commands, []);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Update Model Permissions/);
});

test("mycli shell command palette includes backend-supported commands", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		commands: [
			slashCommand("tasks", "/tasks", "Inspect tasks"),
			slashCommand("changes", "/changes", "Inspect changes"),
			slashCommand("trace", "/trace", "Inspect trace"),
			slashCommand("sandbox", "/sandbox", "Inspect sandbox"),
			slashCommand("permissions", "/permissions", "Inspect permissions"),
		],
	});

	runtime.start();
	await setTimeout(25);
	runtime.showCommandPalette();
	const assertCommandVisible = async (pattern: RegExp) => {
		for (let index = 0; index < 40; index += 1) {
			const output = stripAnsi(runtime.ui.render(100).join("\n"));
			if (pattern.test(output)) {
				return;
			}
			terminal.input?.("\x1b[B");
			await setTimeout(0);
		}
		assert.match(stripAnsi(runtime.ui.render(100).join("\n")), pattern);
	};

	await assertCommandVisible(/\/tasks/);
	await assertCommandVisible(/\/changes/);
	await assertCommandVisible(/\/trace/);
	await assertCommandVisible(/\/sandbox/);
	await assertCommandVisible(/\/permissions/);
	assert.doesNotMatch(stripAnsi(runtime.ui.render(100).join("\n")), /\/tasks agents/);
});

test("mycli shell local view command keeps tools visible", async () => {
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
	});

	await runtime.handleClientAction("set_view_mode", "focus");

	assert.equal(runtime.getState().settings?.viewMode, "focus");
	assert.equal(runtime.getState().tools.find((tool) => tool.name === "Read")?.hidden, false);
	assert.equal(runtime.getState().tools.find((tool) => tool.name === "Edit")?.hidden, false);
});

test("mycli shell local copy and hotkeys commands render useful feedback", async () => {
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
	});

	await runtime.handleClientAction("copy_last_response", "");
	await runtime.handleClientAction("open_hotkeys", "");

	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Copied last assistant message|Clipboard unavailable/);
	assert.match(output, /Hotkeys/);
	assert.match(output, /ctrl\+l/);
	assert.match(output, /ctrl\+o/);
});

test("mycli shell runtime stops terminal before exit callback can close streams", async () => {
	const terminal = new ClosableTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onExit: () => {
			terminal.closed = true;
		},
	});
	runtime.start();

	await runtime.shutdown();

	assert.equal(terminal.stopped, true);
	assert.equal(terminal.closed, true);
	assert.equal(runtime.isStarted(), false);
});

test("mycli shell runtime supports internal transcript page scrolling", async () => {
	const terminal = new TestTerminal();
	terminal.rows = 12;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 20 }, (_, index) => ({
				id: `m${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
		},
		terminal,
	});
	runtime.start();
	await setTimeout(25);
	assert.match(stripAnsi(terminal.output), /message 19/);
	const redrawsAfterStart = runtime.ui.fullRedraws;
	const clearsAfterStart = terminal.fullClearCount();

	terminal.input?.("\x1b[5~");
	await setTimeout(25);
	assert.ok(runtime.getTranscriptScrollOffset() > 0);
	assert.match(stripAnsi(terminal.output), /message 1[0-8]/);
	assert.equal(runtime.ui.fullRedraws, redrawsAfterStart);
	assert.equal(terminal.fullClearCount(), clearsAfterStart);

	terminal.input?.("\x1b[6~");
	await setTimeout(25);
	assert.equal(runtime.getTranscriptScrollOffset(), 0);
	assert.equal(runtime.ui.fullRedraws, redrawsAfterStart);
	assert.equal(terminal.fullClearCount(), clearsAfterStart);
});

test("mycli shell writes full initial history when terminal has native scrollback", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 18 }, (_, index) => ({
				id: `history-${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `history message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	const oldestHistory = output.indexOf("history message 0");
	const header = output.indexOf("mycli ctrl+p commands");
	assert.ok(oldestHistory >= 0);
	assert.ok(header >= 0);
	assert.ok(oldestHistory > header);
	assert.equal(output.match(/mycli ctrl\+p commands/g)?.length, 1);
	assert.match(output, /history message 17/);
});

test("mycli shell replays only the recent transcript tail when history exceeds the row cap", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 30 }, (_, index) => ({
				id: `bounded-history-${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `bounded history message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
		transcriptReplayMaxRows: 12,
	});

	runtime.start();
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	assert.doesNotMatch(output, /bounded history message 0(?:\D|$)/);
	assert.doesNotMatch(output, /bounded history message 10(?:\D|$)/);
	assert.match(output, /bounded history message 29/);
});

test("mycli shell treats a zero transcript replay row cap as disabled", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 30 }, (_, index) => ({
				id: `unbounded-history-${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `unbounded history message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
		transcriptReplayMaxRows: 0,
	});

	runtime.start();
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	assert.match(output, /unbounded history message 0(?:\D|$)/);
	assert.match(output, /unbounded history message 29/);
});

test("native scrollback owns transcript navigation instead of the internal viewport", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 12;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 20 }, (_, index) => ({
				id: `native-scroll-${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `native scroll message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\x1b[5~");
	await setTimeout(25);

	assert.equal(runtime.getTranscriptScrollOffset(), 0);
});

test("bounded transcript replay commits rows displaced by a newly appended block", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 10;
	const messages = Array.from({ length: 24 }, (_, index) => ({
		id: `rolling-history-${index}`,
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		text: `rolling history message ${index}`,
	}));
	const initial = {
		...sampleState(),
		messages,
		tools: [],
		bash: [],
		transcript: undefined,
		pendingNotice: undefined,
	};
	const runtime = new MycliShellRuntime({
		initialState: initial,
		terminal,
		transcriptReplayMaxRows: 16,
	});

	runtime.start();
	await setTimeout(25);
	terminal.output = "";
	runtime.setState({
		...initial,
		messages: [
			...messages,
			{
				id: "rolling-history-new",
				role: "assistant",
				text: Array.from({ length: 12 }, (_, index) => `new rolling line ${index}`).join("\n"),
			},
		],
	});
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	assert.match(output, /rolling history message 23/);
	assert.match(output, /new rolling line 11/);
});

test("mycli shell keeps the session header before a long markdown table", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 10;
	const tableRows = Array.from({ length: 12 }, (_, index) => `| ${index + 1} | change ${index + 1} | effect ${index + 1} |`);
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: [
				{
					id: "table-answer",
					role: "assistant",
					text: [
						"Path to production:",
						"",
						"| Stage | Change | Effect |",
						"| --- | --- | --- |",
						...tableRows,
					].join("\n"),
				},
			],
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	const header = output.indexOf("mycli ctrl+p commands");
	const tableHeader = output.indexOf("Stage");
	assert.ok(header >= 0);
	assert.ok(tableHeader > header);
	assert.equal(output.match(/mycli ctrl\+p commands/g)?.length, 1);
});

test("mycli shell bounds native scrollback after initial history during assistant streaming", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 16;
	const history = Array.from({ length: 20 }, (_, index) => ({
		id: `history-${index}`,
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		text: `history message ${index}`,
	}));
	const initial = {
		...sampleState(),
		messages: [...history, { id: "assistant-stream", role: "assistant" as const, text: "streaming" }],
		tools: [],
		bash: [],
		transcript: undefined,
		pendingNotice: undefined,
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });

	runtime.start();
	await setTimeout(25);
	assert.match(stripAnsi(terminal.output), /history message 0/);
	const liveFrame = stripAnsi(runtime.ui.render(terminal.columns).join("\n"));
	assert.doesNotMatch(liveFrame, /history message 0/);
	assert.match(liveFrame, /streaming/);

	const redrawsAfterStart = runtime.ui.fullRedraws;
	terminal.output = "";
	runtime.setState({
		...initial,
		messages: [...history, { id: "assistant-stream", role: "assistant", text: "streaming token" }],
	});
	await setTimeout(25);

	assert.doesNotMatch(stripAnsi(terminal.output), /history message 0/);
	assert.equal(runtime.ui.fullRedraws, redrawsAfterStart);
	assertNativeScrollbackSafeOutput(terminal.output);
});

test("mycli shell commits a resumed user message before a long streamed tail", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 16;
	const history = Array.from({ length: 20 }, (_, index) => ({
		id: `resumed-${index}`,
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		text: `resumed history ${index}`,
	}));
	let runtime: MycliShellRuntime;
	runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSessionSelect: async (sessionId) => {
			runtime.setState({
				...runtime.getState(),
				messages: history,
				tools: [],
				bash: [],
				transcript: undefined,
				footer: { ...runtime.getState().footer, sessionName: sessionId },
			});
		},
	});

	runtime.start();
	await setTimeout(25);
	runtime.showSessionSelector();
	await setTimeout(25);
	terminal.input?.("\r");
	await setTimeout(50);

	const resumed = runtime.getState();
	const user = { id: "new-user", role: "user" as const, text: "train a small model from scratch" };
	runtime.setState({
		...resumed,
		messages: [...history, user],
		footer: { ...resumed.footer, liveState: "Running" },
	});
	await setTimeout(25);
	terminal.output = "";

	const assistant = {
		id: "new-assistant",
		role: "assistant" as const,
		text: Array.from({ length: 40 }, (_, index) => `streamed answer ${index}`).join("\n"),
	};
	runtime.setState({
		...runtime.getState(),
		messages: [...history, user, assistant],
	});
	await setTimeout(25);
	const nextAssistant = { ...assistant, text: `${assistant.text}\nstreamed answer 40` };
	runtime.setState({
		...runtime.getState(),
		messages: [...history, user, nextAssistant],
	});
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	const userRow = output.indexOf(user.text);
	assert.ok(userRow >= 0);
	assert.match(output, /streamed answer 40/);
	assert.doesNotMatch(output, /mycli ctrl\+p commands/);
	assert.doesNotMatch(terminal.output, /\x1b\[J/);
	assert.equal(output.match(/train a small model from scratch/g)?.length, 1);
	assertNativeScrollbackSafeOutput(terminal.output);
});

test("native TUI appends history deltas queued before one frame", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 4;
	const ui = new TUI(terminal);
	ui.addChild(new Text("live frame"));
	ui.insertHistoryBeforeNextFrame(["first history delta"]);
	ui.insertHistoryBeforeNextFrame(["second history delta"]);
	ui.start();
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	const first = output.indexOf("first history delta");
	const second = output.indexOf("second history delta");
	const frame = output.indexOf("live frame");
	assert.ok(first >= 0);
	assert.ok(second > first);
	assert.ok(frame > second);
});

test("native TUI does not push mutable frame rows into physical scrollback", async () => {
	const terminal = new ScrollbackTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 4;
	terminal.columns = 40;
	const ui = new TUI(terminal);
	const frame = new Text("mutable row 1\nmutable row 2\nmutable row 3\nmutable row 4");
	ui.addChild(frame);
	ui.insertHistoryBeforeNextFrame(["committed history"]);
	ui.start();
	await setTimeout(25);

	assert.deepEqual(terminal.scrollback.filter((line) => line.includes("mutable row")), []);
	frame.setText("mutable row 1\nmutable row 2\nmutable row 3\nmutable row 4\nmutable row 5");
	ui.requestRender();
	await setTimeout(25);

	assert.deepEqual(terminal.scrollback.filter((line) => line.includes("mutable row")), []);
});

test("native TUI clears the live viewport before scrolling history", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 200;
	const ui = new TUI(terminal);
	ui.addChild(new Text("old frame"));
	ui.start();
	await setTimeout(25);
	terminal.output = "";

	ui.insertHistoryBeforeNextFrame(["committed history"], { clearViewport: true });
	ui.requestRender();
	await setTimeout(25);

	assert.ok(terminal.output.startsWith("\x1b[?2026h\x1b[H\x1b[J"));
	assert.doesNotMatch(terminal.output.slice(0, terminal.output.indexOf("committed history")), /\x1b\[1B/);
});

test("native history watermark resets after terminal width changes", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	terminal.columns = 100;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 18 }, (_, index) => ({
				id: `history-${index}`,
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				text: `history message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.columns = 60;
	terminal.resize?.();
	await setTimeout(120);
	terminal.output = "";
	runtime.setState({ ...runtime.getState() });
	await setTimeout(25);

	assert.doesNotMatch(stripAnsi(terminal.output), /history message/);
});

test("mycli shell appends new history into native scrollback without mouse capture", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	const initial = {
		...sampleState(),
		messages: Array.from({ length: 12 }, (_, index) => ({
			id: `history-${index}`,
			role: index % 2 === 0 ? "user" as const : "assistant" as const,
			text: `history message ${index}`,
		})),
		tools: [],
		bash: [],
		transcript: undefined,
		pendingNotice: undefined,
	};
	const runtime = new MycliShellRuntime({
		initialState: initial,
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.output = "";
	runtime.setState({
		...initial,
		messages: [
			...initial.messages,
			{ id: "history-new", role: "assistant" as const, text: "new appended history" },
		],
	});
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	assert.match(output, /new appended history/);
	assertNativeScrollbackSafeOutput(terminal.output);
	assert.equal(terminal.fullClearCount(), 0);
});

test("native scrollback commits a tall slash command block in one state update", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 12;
	const assistant = {
		id: "assistant-history",
		role: "assistant" as const,
		text: Array.from({ length: 12 }, (_, index) => `history line ${index + 1}`).join("\n"),
	};
	const initial: MycliShellState = {
		...sampleState(),
		messages: [assistant],
		tools: [],
		bash: [],
		transcript: [{ id: assistant.id, kind: "message", message: assistant }],
		pendingNotice: undefined,
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	runtime.start();
	await setTimeout(25);
	terminal.output = "";

	runtime.setState({
		...initial,
		transcript: [
			...initial.transcript!,
			{
				id: "command-usage",
				kind: "command_result",
				commandResult: {
					id: "command-usage",
					display: {
						version: 1,
						kind: "diagnostic",
						command: "/usage",
						title: "Usage",
						severity: "info",
						fields: [
							{ label: "Session", value: "session-demo" },
							{ label: "Turns", value: "5" },
						],
						rows: [],
						sections: [
							{
								title: "Cumulative usage",
								fields: [
									{ label: "Input tokens", value: "64291" },
									{ label: "Output tokens", value: "1523" },
									{ label: "Cache read tokens", value: "53120" },
								],
								rows: [],
							},
						],
						suggestions: [],
						omittedRows: 0,
						omittedChars: 0,
					},
					fallbackLines: [],
					folded: false,
				},
			},
		],
	});
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	assert.match(output, /\/usage/);
	assert.match(output, /╭─+/);
	assert.match(output, /Session\s+session-demo/);
	assert.match(output, /Cache read tokens\s+53120/);
	assert.match(output, /╰─+/);
	assertNativeScrollbackSafeOutput(terminal.output);
});

test("native scrollback does not replay a tall slash card during the next turn", async () => {
	const terminal = new ScrollbackTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 12;
	const assistant = {
		id: "assistant-before-usage",
		role: "assistant" as const,
		text: "Python script completed normally.",
	};
	const usage = {
		id: "command-usage-once",
		kind: "command_result" as const,
		commandResult: {
			id: "command-usage-once",
			display: {
				version: 1 as const,
				kind: "diagnostic" as const,
				command: "/usage",
				title: "Usage",
				severity: "info" as const,
				fields: [
					{ label: "Session", value: "session-demo" },
					{ label: "Turns", value: "43" },
				],
				rows: [],
				sections: [
					{
						title: "Current context window",
						fields: [
							{ label: "Input tokens", value: "16217" },
							{ label: "Max tokens", value: "100000" },
							{ label: "Usage ratio", value: "16.2%" },
						],
						rows: [],
					},
					{
						title: "Cumulative usage",
						fields: [
							{ label: "Input tokens", value: "608786" },
							{ label: "Output tokens", value: "9079" },
							{ label: "Cache read tokens", value: "570752" },
						],
						rows: [],
					},
				],
				suggestions: [],
				omittedRows: 0,
				omittedChars: 0,
			},
			fallbackLines: [],
			folded: false,
		},
	};
	const initial: MycliShellState = {
		...sampleState(),
		messages: [assistant],
		tools: [],
		bash: [],
		transcript: [
			{ id: assistant.id, kind: "message", message: assistant },
			usage,
		],
		pendingNotice: undefined,
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	runtime.start();
	await setTimeout(25);

	const user = { id: "user-after-usage", role: "user" as const, text: "run it again" };
	runtime.setState({
		...initial,
		messages: [assistant, user],
		transcript: [
			...initial.transcript!,
			{ id: user.id, kind: "message", message: user },
		],
		footer: { ...initial.footer, liveState: "Running" },
	});
	await setTimeout(25);
	terminal.output = "";

	runtime.setState({
		...runtime.getState(),
		footer: {
			...runtime.getState().footer,
			liveState: "Running",
			liveStateDetail: "Executing Shell",
		},
	});
	await setTimeout(25);
	const answer = { id: "assistant-after-usage", role: "assistant" as const, text: "ok" };
	runtime.setState({
		...runtime.getState(),
		messages: [assistant, user, answer],
		transcript: [
			...runtime.getState().transcript!,
			{ id: answer.id, kind: "message", message: answer },
		],
		footer: { ...runtime.getState().footer, liveState: "Completed" },
	});
	await setTimeout(25);

	assert.doesNotMatch(stripAnsi(terminal.output), /\/usage/);
	const physicalOutput = terminal.physicalLines().join("\n");
	assert.equal(physicalOutput.match(/\/usage/g)?.length, 1);
	assert.equal(physicalOutput.match(/Python script completed normally\./g)?.length, 1);
	assert.equal(physicalOutput.match(/run it again/g)?.length, 1);
});

test("mycli shell does not clear screen when submitting into long native scrollback history", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	const initial = {
		...sampleState(),
		messages: Array.from({ length: 40 }, (_, index) => ({
			id: `history-${index}`,
			role: index % 2 === 0 ? "user" as const : "assistant" as const,
			text: `history message ${index}`,
		})),
		tools: [],
		bash: [],
		transcript: undefined,
		pendingNotice: undefined,
	};
	const runtime = new MycliShellRuntime({
		initialState: initial,
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.output = "";
	runtime.setState({
		...initial,
		messages: [
			...initial.messages,
			{ id: "submitted-user", role: "user" as const, text: "new submitted message" },
		],
		footer: {
			...initial.footer,
			liveState: "Running",
		},
	});
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	assert.match(output, /new submitted message/);
	assertNativeScrollbackSafeOutput(terminal.output);
	assert.equal(terminal.fullClearCount(), 0);
});

test("mycli shell rebuilds native scrollback from transcript source after resize", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	terminal.columns = 80;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 12 }, (_, index) => ({
				id: `history-${index}`,
				role: index % 2 === 0 ? "user" as const : "assistant" as const,
				text: `history message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.output = "";
	terminal.columns = 100;
	terminal.resize?.();
	await setTimeout(120);

	assert.match(terminal.output, /\x1b\[r\x1b\[0m\x1b\[H\x1b\[2J\x1b\[3J\x1b\[H/);
	const output = stripAnsi(terminal.output);
	assert.equal(output.match(/history message 0(?:\D|$)/g)?.length, 1);
	assert.equal(output.match(/history message 11(?:\D|$)/g)?.length, 1);
});

test("mycli shell coalesces rapid native resize events into one source rebuild", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	terminal.columns = 80;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: [
				{ id: "resize-user", role: "user", text: "a long resize-sensitive message that must be rewrapped from source" },
				{ id: "resize-assistant", role: "assistant", text: "the matching answer also belongs to source-backed history" },
			],
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.output = "";

	terminal.columns = 72;
	terminal.resize?.();
	terminal.columns = 58;
	terminal.resize?.();
	terminal.columns = 44;
	terminal.resize?.();
	await setTimeout(120);

	assert.equal(terminal.output.match(/\x1b\[3J/g)?.length, 1);
	for (const line of runtime.editor.render(terminal.columns)) {
		assert.ok(visibleWidth(line) < terminal.columns, `editor line reached wrap column: ${stripAnsi(line)}`);
	}
});

test("native resize holds streaming frames until the source rebuild", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 8;
	terminal.columns = 80;
	const initial = {
		...sampleState(),
		messages: [{ id: "resize-stream", role: "assistant" as const, text: "stream prefix" }],
		tools: [],
		bash: [],
		transcript: undefined,
		pendingNotice: undefined,
	};
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	runtime.start();
	await setTimeout(25);
	terminal.output = "";

	terminal.columns = 44;
	terminal.resize?.();
	runtime.setState({
		...initial,
		messages: [{ id: "resize-stream", role: "assistant", text: "stream prefix and tail" }],
	});
	await setTimeout(25);
	assert.equal(terminal.output, "");

	await setTimeout(100);
	assert.equal(terminal.output.match(/\x1b\[3J/g)?.length, 1);
	assert.equal(stripAnsi(terminal.output).match(/stream prefix and tail/g)?.length, 1);
});

test("alternate-screen resize clears only its buffer and keeps rows below wrap width", async () => {
	const terminal = new TestTerminal();
	terminal.alternateScreen = true;
	terminal.rows = 8;
	terminal.columns = 80;
	const runtime = new MycliShellRuntime({ initialState: sampleState(), terminal });

	runtime.start();
	await setTimeout(25);
	terminal.output = "";
	terminal.columns = 44;
	terminal.resize?.();
	await setTimeout(25);

	assert.match(terminal.output, /\x1b\[2J\x1b\[H/);
	assert.doesNotMatch(terminal.output, /\x1b\[3J/);
	for (const line of runtime.editor.render(terminal.columns)) {
		assert.ok(visibleWidth(line) < terminal.columns, `editor line reached wrap column: ${stripAnsi(line)}`);
	}
});

test("alternate-screen resize emits exactly one bounded terminal frame", async () => {
	const terminal = new TestTerminal();
	terminal.alternateScreen = true;
	terminal.rows = 12;
	terminal.columns = 80;
	const runtime = new MycliShellRuntime({ initialState: sampleState(), terminal });
	const assertBoundedFrame = () => {
		const start = terminal.output.indexOf("\x1b[?2026h");
		const end = terminal.output.indexOf("\x1b[?2026l", start);
		assert.ok(start >= 0 && end > start, "missing synchronized frame");
		const frame = terminal.output.slice(start, end);
		const rows = frame.split("\r\n");
		assert.equal(rows.length, terminal.rows, `frame row count: ${rows.length}`);
		for (const row of rows) {
			assert.ok(visibleWidth(row) < terminal.columns, `frame row reached wrap column ${terminal.columns}`);
		}
	};

	runtime.start();
	await setTimeout(25);

	terminal.output = "";
	terminal.columns = 36;
	terminal.rows = 5;
	terminal.resize?.();
	await setTimeout(25);
	assertBoundedFrame();

	terminal.output = "";
	terminal.columns = 100;
	terminal.rows = 14;
	terminal.resize?.();
	await setTimeout(25);
	assertBoundedFrame();
});

test("alternate-screen resize preserves transcript scroll position", async () => {
	const terminal = new TestTerminal();
	terminal.alternateScreen = true;
	terminal.rows = 12;
	terminal.columns = 100;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 30 }, (_, index) => ({
				id: `resize-scroll-${index}`,
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				text: `message ${index} ${"width-sensitive content ".repeat(4)}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
		},
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	terminal.input?.("\x1b[5~");
	await setTimeout(25);
	const beforeResize = runtime.getTranscriptScrollOffset();
	assert.ok(beforeResize > 0);

	terminal.columns = 44;
	terminal.resize?.();
	await setTimeout(25);

	assert.equal(runtime.getTranscriptScrollOffset(), beforeResize, "resize changed transcript scroll position");
});

test("native TUI keeps relative resize positioning before content fills the viewport", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 12;
	terminal.columns = 80;
	const ui = new TUI(terminal);
	ui.addChild(new Text("short setup surface", 0, 0));

	ui.start();
	await setTimeout(25);
	terminal.output = "";
	terminal.columns = 60;
	terminal.resize?.();
	await setTimeout(25);

	assert.doesNotMatch(terminal.output, /\x1b\[H/);
});

test("mycli shell runtime scrolls only transcript and keeps chrome visible", async () => {
	const terminal = new TestTerminal();
	terminal.rows = 12;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 20 }, (_, index) => ({
				id: `m${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
	});
	runtime.start();
	await setTimeout(25);
	terminal.output = "";

	terminal.input?.("\x1b[5~");
	await setTimeout(25);

	const output = stripAnsi(terminal.output);
	assert.match(output, /message 1[0-9]/);
	const screen = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(screen, /mycli/);
	assert.match(screen, /enter send/);
	assert.match(screen, /deepseek-v4-flash/);
});

test("mycli shell runtime supports terminal wheel-style transcript scrolling", async () => {
	const terminal = new TestTerminal();
	terminal.rows = 12;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 20 }, (_, index) => ({
				id: `m${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
	});
	runtime.start();
	await setTimeout(25);
	const redrawsAfterStart = runtime.ui.fullRedraws;
	const clearsAfterStart = terminal.fullClearCount();

	terminal.input?.("\x1b[A");
	await setTimeout(25);
	assert.ok(runtime.getTranscriptScrollOffset() > 0);
	assert.equal(runtime.ui.fullRedraws, redrawsAfterStart);
	assert.equal(terminal.fullClearCount(), clearsAfterStart);

	terminal.input?.("\x1b[B");
	await setTimeout(25);
	assert.equal(runtime.getTranscriptScrollOffset(), 0);
	assert.equal(runtime.ui.fullRedraws, redrawsAfterStart);
	assert.equal(terminal.fullClearCount(), clearsAfterStart);
});

test("mycli shell runtime supports SGR mouse wheel transcript scrolling", async () => {
	const terminal = new TestTerminal();
	terminal.rows = 12;
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			messages: Array.from({ length: 20 }, (_, index) => ({
				id: `m${index}`,
				role: index % 2 === 0 ? "user" : "assistant",
				text: `message ${index}`,
			})),
			tools: [],
			bash: [],
			transcript: undefined,
			pendingNotice: undefined,
		},
		terminal,
	});
	runtime.start();
	await setTimeout(25);
	const redrawsAfterStart = runtime.ui.fullRedraws;
	const clearsAfterStart = terminal.fullClearCount();

	terminal.input?.("\x1b[<64;10;5M");
	await setTimeout(25);
	assert.ok(runtime.getTranscriptScrollOffset() > 0);
	assert.equal(runtime.ui.fullRedraws, redrawsAfterStart);
	assert.equal(terminal.fullClearCount(), clearsAfterStart);

	terminal.input?.("\x1b[<65;10;5M");
	await setTimeout(25);
	assert.equal(runtime.getTranscriptScrollOffset(), 0);
	assert.equal(runtime.ui.fullRedraws, redrawsAfterStart);
	assert.equal(terminal.fullClearCount(), clearsAfterStart);
});

test("promoted compiled code and tests do not keep legacy copied naming", () => {
	const forbidden = [
		"P" + "iShell",
		"pi" + "shell",
		"pi" + "-tui",
		"P" + "I_",
		"@earendil-works/" + "pi",
		"@mariozechner/" + "pi",
		"pi" + "-agent",
		"pi" + "-ai",
		"pi" + "-coding",
	].join("|");
	const result = spawnSync(
		"rg",
		[
			forbidden,
			"src",
			"test",
			"-n",
		],
		{ cwd: new URL("..", import.meta.url), encoding: "utf8" },
	);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.equal(result.stdout, "");
});

test("gateway resolves interrupted inputs only after the backend terminal event", () => {
	const source = readFileSync(new URL("../src/gateway.ts", import.meta.url), "utf8");
	const interruptBody = source.match(
		/async function interruptTurn\([\s\S]*?\): Promise<boolean> \{([\s\S]*?)\n\}/,
	)?.[1] ?? "";

	assert.match(source, /popLastLocalFollowUp\(runtimeState\)/);
	assert.match(source, /resolveLocalInterruptInputs\(/);
	assert.match(source, /completeInterruptedTurn\(/);
	assert.doesNotMatch(source, /send\("turn\.queue\.pop"/);
	assert.doesNotMatch(source, /send\("turn\.queue\.clear"/);
	assert.doesNotMatch(
		interruptBody,
		/resolveLocalInterruptInputs|completeInterruptedTurn|dequeueQueuedInput|popLastQueuedFollowUp|clearQueuedTurns/,
	);
});

test("scripted gateway client follows backend user lifecycle and local follow-up queues", () => {
	const source = readFileSync(new URL("./support/scripted-client.ts", import.meta.url), "utf8");

	assert.match(source, /client_user_message_id/);
	assert.match(source, /runtimeStateWithSubmittingMessage/);
	assert.match(source, /runtimeStateWithPendingSteer/);
	assert.match(source, /runtimeStateWithLocalFollowUp/);
	assert.doesNotMatch(source, /runtimeStateWithUserMessage/);
	assert.doesNotMatch(source, /send\("turn\.follow_up"/);
	assert.doesNotMatch(source, /send\("turn\.queue\.(?:pop|clear)"/);
});

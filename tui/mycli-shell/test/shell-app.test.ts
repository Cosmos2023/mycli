import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { join } from "node:path";
import type { Terminal } from "../src/tui-core/terminal.ts";
import { Editor } from "../src/tui-core/components/editor.ts";
import { visibleWidth } from "../src/tui-core/tui.ts";
import { spawnSync } from "node:child_process";
import { BashExecutionComponent, FooterComponent, MycliShellRuntime, renderMycliShell, ToolExecutionComponent, TrustSelectorComponent, type MycliShellState } from "../src/index.ts";
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
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			scoped: true,
		},
		models: [
			{
				provider: "deepseek",
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				scoped: true,
			},
			{
				provider: "openai",
				id: "gpt-5.4",
				name: "GPT 5.4",
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
	assert.doesNotMatch(output, /Thinking\.\.\./);
	assert.doesNotMatch(output, /I should inspect the file/);
	assert.match(output, /Summary: hello/);
	assert.match(output, /Read/);
	assert.match(output, /Edit/);
	assert.match(output, /Patch did not apply/);
	assert.match(output, /⏺ Bash/);
	assert.match(output, /⎿ pytest -q · exit 1/);
	assert.match(output, /Waiting for approval/);
	assert.match(output, /deepseek-v4-flash/);
});

test("mycli shell collapses long assistant python code blocks", () => {
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
	assert.doesNotMatch(output, /print\("line_16"\)/);
	assert.match(output, /\.\.\. 8 more lines/);
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

test("mycli shell renders only running same-turn subagents in main progress", () => {
	const output = stripAnsi(
		renderMycliShell(
			subagentPanelState(),
			100,
		).join("\n"),
	);

	assert.match(output, /Running agent/);
	assert.match(output, /└─ explore \(Inspect auth bug\) · 2 tool uses/);
	assert.match(output, /⎿ Read path=src\/auth\/session\.py/);
	assert.match(output, /⎿ Found token refresh logic/);
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

	runtime.editor.setText("/tasks");
	await runtime.editor.onSubmit?.("/tasks");
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
	assert.doesNotMatch(output, /◇ 1 agent done/);
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

test("mycli shell completed background subagent is not an active tasks entry", async () => {
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
	runtime.editor.setText("/tasks");
	await runtime.editor.onSubmit?.("/tasks");
	await setTimeout(25);

	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /No background agents currently running/);
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
	runtime.editor.setText("/tasks");
	await runtime.editor.onSubmit?.("/tasks");
	await setTimeout(25);
	terminal.input?.("x");
	await setTimeout(25);

	assert.deepEqual(commands, ["/tasks agents kill child-session-bg"]);
	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Stopping @explore \(child-session-bg\)\./);
});

test("mycli shell renders active plan panel above the composer", () => {
	const state: MycliShellState = {
		...sampleState(),
		pendingNotice: undefined,
		activePlan: [
			{ id: "step-1", status: "completed", text: "Inspect runtime state" },
			{ id: "step-2", status: "in_progress", text: "Render active plan" },
			{ id: "step-3", status: "pending", text: "Verify shell tests" },
		],
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));
	const planIndex = output.indexOf("[plan] 1/3");
	const composerIndex = output.indexOf("Message mycli");

	assert.ok(planIndex >= 0, output);
	assert.ok(composerIndex > planIndex, output);
	assert.match(output, /✓ Inspect runtime state/);
	assert.match(output, /● Render active plan/);
	assert.match(output, /next: Verify shell tests/);
});

test("mycli shell renders active plan compactly with current evidence", () => {
	const state: MycliShellState = {
		...sampleState(),
		pendingNotice: undefined,
		activePlan: [
			{ id: "step-1", status: "completed", text: "Inspect runtime state" },
			{
				id: "step-2",
				status: "in_progress",
				text: "Run focused tests",
				evidence: ["pytest targeted tests passed"],
			},
			{ id: "step-3", status: "pending", text: "Summarize changes" },
			{ id: "step-4", status: "pending", text: "Update docs" },
			{ id: "step-5", status: "pending", text: "Run full verification" },
		],
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));
	const planLines = stripAnsi(renderMycliShell(state, 100).join("\n"))
		.split("\n")
		.filter((line) => /\[plan\]|Run focused tests|evidence:|next:/.test(line));

	assert.equal(planLines.length, 4, planLines.join("\n"));
	assert.match(output, /● Run focused tests/);
	assert.match(output, /evidence: pytest targeted tests passed/);
	assert.match(output, /next: Summarize changes \+2/);
	assert.doesNotMatch(output, /○ Update docs/);
});

test("mycli shell keeps long active plans compact", () => {
	const state: MycliShellState = {
		...sampleState(),
		pendingNotice: undefined,
		activePlan: Array.from({ length: 12 }, (_, index) => ({
			id: `step-${index + 1}`,
			status: index === 4 ? "in_progress" : index < 4 ? "completed" : "pending",
			text: `Plan item ${index + 1}`,
		})),
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));
	const planLines = output
		.split("\n")
		.filter((line) => /\[plan\]|Plan item|next:/.test(line));

	assert.equal(planLines.length, 4, planLines.join("\n"));
	assert.match(output, /\[plan\] 4\/12/);
	assert.match(output, /✓ Plan item 4/);
	assert.match(output, /● Plan item 5/);
	assert.match(output, /next: Plan item 6 \+6/);
	assert.doesNotMatch(output, /Plan item 12/);
});

test("mycli shell omits completed active plan panel", () => {
	const state: MycliShellState = {
		...sampleState(),
		pendingNotice: undefined,
		activePlan: undefined,
	};

	const output = stripAnsi(renderMycliShell(state, 100).join("\n"));

	assert.doesNotMatch(output, /\[plan\] 2\/2/);
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
	for (const line of renderMycliShell(sampleState(), width)) {
		assert.ok(visibleWidth(line) <= width, `line too wide: ${stripAnsi(line)}`);
	}
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
	assert.match(stripAnsi(lines.join("\n")), /~\/Desktop\/mycli/);
	assert.match(stripAnsi(lines.join("\n")), /91\.2%\/128k/);
	assert.match(stripAnsi(lines.join("\n")), /status with control chars/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 64, `line too wide: ${stripAnsi(line)}`);
	}
});

test("footer renders collaboration mode when space allows", () => {
	const footer = new FooterComponent({
		cwd: "/repo",
		model: "gpt-5.4",
		collaborationMode: "plan",
		liveState: "Plan",
	});

	const output = stripAnsi(footer.render(48).join("\n"));

	assert.match(output, /mode plan/);
});

test("mycli shell renders command diagnostics as structured panels", () => {
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

	assert.match(plain, /Usage \/usage/);
	assert.match(plain, /Estimated cost: 0\.123/);
	assert.match(plain, /Cumulative tokens/);
	assert.match(plain, /Context \/context/);
	assert.match(plain, /Context composition/);
	assert.doesNotMatch(plain, /\[usage\] cumulative_usage/);
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
	assert.match(output, /@@ -1 \+1 @@/);
	assert.match(output, /-old/);
	assert.match(output, /\+new/);
});

test("bash rendering keeps long commands folded to a Claude-like preview", () => {
	const longCommand = ["python - <<'PY'", ...Array.from({ length: 20 }, () => "print('hello')"), "PY"].join("\n");
	const rendered = new BashExecutionComponent({
		id: "bash",
		command: longCommand,
		status: "running",
	});

	const output = stripAnsi(rendered.render(100).join("\n"));

	assert.match(output, /⏺ Bash/);
	assert.match(output, /⎿ python - <<'PY'… · Running/);
	assert.doesNotMatch(output, /print\('hello'\)/);
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

	assert.equal(runtime.ui.children[0], runtime.headerContainer);
	assert.equal(runtime.ui.children[1], runtime.transcriptViewport);
	assert.equal(runtime.ui.children[2], runtime.pendingMessagesContainer);
	assert.equal(runtime.ui.children[3], runtime.statusContainer);
	assert.equal(runtime.ui.children[4], runtime.editorContainer);
	assert.equal(runtime.ui.children[5], runtime.subagentTaskContainer);
	assert.equal(runtime.ui.children[6], runtime.footerContainer);

	const output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /mycli/);
	assert.match(output, /Read word\.txt/);
	assert.match(output, /Message mycli/);
	assert.match(output, /deepseek-v4-flash/);
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

	runtime.setState({
		...initial,
		messages: [{ id: "assistant-1", role: "assistant", text: "hello" }],
		transcript: [
			{ id: "assistant-1", kind: "message", message: { id: "assistant-1", role: "assistant", text: "hello" } },
		],
	});

	assert.equal(runtime.chatContainer.children[0], component);
	assert.match(stripAnsi(runtime.chatContainer.render(100).join("\n")), /hello/);
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

test("mycli shell runtime renders thinking elapsed and completion duration with the active turn", async () => {
	const terminal = new TestTerminal();
	let now = 10_000;
	const runtime = new MycliShellRuntime({
		initialState: { ...sampleState(), footer: { ...sampleState().footer, liveState: "Idle" } },
		terminal,
		now: () => now,
	});

	runtime.setState({ ...runtime.getState(), footer: { ...runtime.getState().footer, liveState: "Running" } });
	let output = stripAnsi(runtime.chatContainer.render(100).join("\n"));
	assert.match(output, /\(Thinking\.\.\. 0 s\)/);
	assert.doesNotMatch(stripAnsi(runtime.statusContainer.render(100).join("\n")), /Thinking|Running/);

	now = 12_400;
	runtime.refreshTurnStatus();
	output = stripAnsi(runtime.chatContainer.render(100).join("\n"));
	assert.match(output, /\(Thinking\.\.\. 2 s\)/);

	now = 13_100;
	runtime.setState({ ...runtime.getState(), footer: { ...runtime.getState().footer, liveState: "Completed" } });
	output = stripAnsi(runtime.chatContainer.render(100).join("\n"));
	assert.match(output, /✻ Completed for 3 s/);
	assert.doesNotMatch(stripAnsi(runtime.statusContainer.render(100).join("\n")), /Completed/);
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
	assert.doesNotMatch(output, /Message mycli/);
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
	assert.doesNotMatch(stripAnsi(terminal.output), /Message mycli/);
	assert.equal(runtime.ui.children.length, 1);

	terminal.input?.("\r");
	await setTimeout(25);
	const output = stripAnsi(terminal.output);
	assert.match(output, /Message mycli/);
	assert.match(output, /deepseek-v4-flash/);
	assert.equal(runtime.getState().footer.trust, "trusted");
	assert.equal(runtime.ui.children[0], runtime.headerContainer);
	assert.equal(runtime.ui.children[4], runtime.editorContainer);
	assert.equal(runtime.ui.children.length, 7);
});

test("mycli shell command palette replaces editor like coding-agent selector", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
	});

	runtime.start();
	await setTimeout(25);
	runtime.showCommandPalette();
	assert.equal(runtime.ui.children[4], runtime.editorContainer);
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /\/trust/);

	terminal.input?.("\x1b");
	await setTimeout(25);
	assert.equal(runtime.editorContainer.children[0], runtime.editor);
});

test("mycli shell approval selector replaces editor and submits selected choice", async () => {
	const terminal = new TestTerminal();
	const approvals: Array<[string, string]> = [];
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			pendingApproval: {
				decisionId: "decision-1",
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
	let output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /Permission required · Bash · @explore/);
	assert.match(output, /demo:sub:turn_1:abcd1234/);
	assert.match(output, /⎿ file \/tmp\/image\.jpg 2>&1/);
	assert.match(output, /→ Allow once/);
	assert.match(output, /1 allow\s+2 reject\s+↑↓ navigate\s+enter confirm\s+esc reject/);
	assert.doesNotMatch(output, /Approval required:/);
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.equal((output.match(/^─{10,}/gm) ?? []).length, 1);

	terminal.input?.("\x1b[B");
	await setTimeout(25);
	output = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(output, /→ Reject/);

	terminal.input?.("\r");
	await setTimeout(25);
	assert.deepEqual(approvals, [["decision-1", "reject"]]);
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

test("mycli shell keeps slash editable and opens commands from question key", async () => {
	const slashTerminal = new TestTerminal();
	const slashRuntime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: slashTerminal,
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
	});

	questionRuntime.start();
	await setTimeout(25);
	questionTerminal.input?.("?");
	await setTimeout(25);
	assert.notEqual(questionRuntime.editorContainer.children[0], questionRuntime.editor);
	assert.match(stripAnsi(questionRuntime.ui.render(100).join("\n")), /\/settings/);
});

test("mycli shell slash autocomplete accepts selected command with tab", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
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

test("mycli shell slash autocomplete filters and submits with enter", async () => {
	const terminal = new TestTerminal();
	const commands: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
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
			selected = `${model.provider}/${model.id}/${model.thinkingLevel ?? ""}`;
		},
	});

	runtime.start();
	await setTimeout(25);
	runtime.editor.setText("/model");
	await runtime.editor.onSubmit?.("/model");
	assert.notEqual(runtime.editorContainer.children[0], runtime.editor);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /deepseek-v4-flash/);

	terminal.input?.("\t");
	terminal.input?.("\x1b[B");
	terminal.input?.("\r");
	await setTimeout(25);
	assert.equal(runtime.editorContainer.children[0], runtime.editor);
	assert.equal(runtime.getState().footer.model, "gpt-5.4");
	assert.equal(runtime.getState().footer.provider, "openai");
	assert.equal(runtime.getState().footer.reasoningLevel, "medium");
	assert.equal(selected, "openai/gpt-5.4/medium");
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
			selected = `${model.provider}/${model.id}/${model.thinkingLevel ?? ""}`;
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.editor.onSubmit?.("/login");

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
	assert.match(output, /deepseek-v4-flash \[deepseek\]/);
	assert.doesNotMatch(output, /gpt-5.4 \[openai\]/);
	assert.match(output, /Saved API key for deepseek/);

	terminal.input?.("\r");
	await setTimeout(25);

	assert.equal(runtime.editorContainer.children[0], runtime.editor);
	assert.equal(selected, "deepseek/deepseek-v4-flash/medium");
});

test("mycli shell model selector can change thinking effort with model selection", async () => {
	const terminal = new TestTerminal();
	let selected = "";
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onModelSelect: (model) => {
			selected = `${model.provider}/${model.id}/${model.thinkingLevel ?? ""}`;
		},
	});

	runtime.start();
	await setTimeout(25);
	await runtime.editor.onSubmit?.("/model");
	const initialOutput = stripAnsi(runtime.ui.render(100).join("\n"));
	assert.match(initialOutput, /Thinking/);
	assert.match(initialOutput, /medium/);

	terminal.input?.("\x1b[C");
	terminal.input?.("\x1b[C");
	terminal.input?.("\r");
	await setTimeout(25);

	assert.equal(runtime.editorContainer.children[0], runtime.editor);
	assert.equal(runtime.getState().footer.reasoningLevel, "xhigh");
	assert.equal(selected, "deepseek/deepseek-v4-flash/xhigh");
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
	runtime.editor.setText("/settings");
	await runtime.editor.onSubmit?.("/settings");
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
	runtime.editor.setText("/session");
	await runtime.editor.onSubmit?.("/session");
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
	runtime.editor.setText("/resources");
	await runtime.editor.onSubmit?.("/resources");
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
	runtime.editor.setText("/session tree");
	await runtime.editor.onSubmit?.("/session tree");
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

	runtime.editor.setText("/session tree");
	await runtime.editor.onSubmit?.("/session tree");
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

	runtime.editor.setText("/clear");
	await runtime.editor.onSubmit?.("/clear");
	assert.equal(runtime.getState().messages.length, 0);
	assert.equal(runtime.getState().tools.length, 0);
	assert.equal(runtime.getState().transcript?.length, 0);
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

test("mycli shell runtime queues follow-up messages with alt enter", async () => {
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
	terminal.input?.("\x1b\r");
	await setTimeout(25);

	assert.deepEqual(followUps, ["after current run"]);
	assert.equal(runtime.editor.getText(), "");
});

test("mycli shell runtime restores queued messages with alt up", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, steeringQueueCount: 1, followUpQueueCount: 1 },
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
});

test("mycli shell runtime interrupts running turns with ctrl c and restores submitted input", async () => {
	let interrupted = 0;
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSubmit: () => undefined,
		onInterrupt: () => {
			interrupted += 1;
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
	assert.equal(runtime.editor.getText(), "draft before send");
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Interrupted/);
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
	await runtime.editor.onSubmit?.("interrupted prompt");
	runtime.setState({
		...runtime.getState(),
		footer: { ...runtime.getState().footer, liveState: "Running" },
	});
	terminal.input?.("\x03");
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "interrupted prompt");
	runtime.editor.setText("");
	runtime.editor.handleInput("\x1b[A");
	await setTimeout(25);

	assert.equal(runtime.editor.getText(), "older prompt");
});

test("mycli shell runtime interrupts running turns with escape", async () => {
	let interrupted = 0;
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: {
			...sampleState(),
			footer: { ...sampleState().footer, liveState: "Running" },
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
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Interrupted/);
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

	assert.deepEqual(submitted, []);
	assert.deepEqual(commands, ["/changes", "/tasks agents child-session", "/trace export"]);
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

test("mycli shell cycles sandbox mode with ctrl x", async () => {
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
	terminal.input?.("\x18");
	await setTimeout(25);

	assert.deepEqual(commands, ["/sandbox next"]);
});

test("mycli shell command palette includes backend-supported commands", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
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

	await assertCommandVisible(/\/tasks agents/);
	await assertCommandVisible(/\/changes/);
	await assertCommandVisible(/\/trace/);
	await assertCommandVisible(/\/session maintenance/);
	await assertCommandVisible(/\/sandbox/);
	await assertCommandVisible(/\/permissions/);
});

test("mycli shell local view command switches tool visibility", async () => {
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
	});

	await runtime.editor.onSubmit?.("/view focus");

	assert.equal(runtime.getState().settings?.viewMode, "focus");
	assert.equal(runtime.getState().tools.find((tool) => tool.name === "Read")?.hidden, true);
	assert.equal(runtime.getState().tools.find((tool) => tool.name === "Edit")?.hidden, false);
});

test("mycli shell local copy and hotkeys commands render useful feedback", async () => {
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal: new TestTerminal(),
	});

	await runtime.editor.onSubmit?.("/copy");
	await runtime.editor.onSubmit?.("/hotkeys");

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
	assert.match(output, /history message 0/);
	assert.match(output, /history message 17/);
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

test("mycli shell does not clear native scrollback terminal across full redraws", async () => {
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
	await setTimeout(25);

	assertNativeScrollbackSafeOutput(terminal.output);
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
	assert.match(screen, /Message mycli/);
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

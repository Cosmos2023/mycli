import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import type { Terminal } from "../src/tui-core/terminal.ts";
import { visibleWidth } from "../src/tui-core/tui.ts";
import { spawnSync } from "node:child_process";
import { FooterComponent, MycliShellRuntime, renderMycliShell, ToolExecutionComponent, TrustSelectorComponent, type MycliShellState } from "../src/index.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
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
			{ id: "session-a", title: "Session A", cwd: "~/Desktop/mycli", modified: "now" },
			{ id: "session-b", title: "Session B", cwd: "~/Desktop/other", modified: "1h" },
		],
		pendingNotice: "Waiting for approval",
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

test("mycli shell renders copied reference shell surfaces", () => {
	const output = stripAnsi(renderMycliShell(sampleState(), 100).join("\n"));

	assert.match(output, /mycli/);
	assert.match(output, /Read word\.txt/);
	assert.match(output, /Thinking\.\.\./);
	assert.doesNotMatch(output, /I should inspect the file/);
	assert.match(output, /Summary: hello/);
	assert.match(output, /Read/);
	assert.match(output, /Edit/);
	assert.match(output, /Patch did not apply/);
	assert.match(output, /\$ pytest -q/);
	assert.match(output, /Waiting for approval/);
	assert.match(output, /deepseek-v4-flash/);
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
	const toolIndex = output.indexOf("Read word.txt");
	const assistantIndex = output.indexOf("done");

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

test("mycli shell rendered lines stay width safe", () => {
	const width = 72;
	for (const line of renderMycliShell(sampleState(), width)) {
		assert.ok(visibleWidth(line) <= width, `line too wide: ${stripAnsi(line)}`);
	}
});

test("footer keeps copied compact shape width safe", () => {
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
	assert.match(output, /changed/);
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
	assert.match(output, /failed/);
	assert.match(output, /boom/);
	assert.match(output, /1\.3s/);
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

test("mycli shell runtime assembles copied reference mounted containers", () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({ initialState: sampleState(), terminal });

	assert.equal(runtime.ui.children[0], runtime.headerContainer);
	assert.equal(runtime.ui.children[1], runtime.transcriptViewport);
	assert.equal(runtime.ui.children[2], runtime.pendingMessagesContainer);
	assert.equal(runtime.ui.children[3], runtime.statusContainer);
	assert.equal(runtime.ui.children[4], runtime.editorContainer);
	assert.equal(runtime.ui.children[5], runtime.footerContainer);

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
	assert.match(stripAnsi(runtime.chatContainer.render(100).join("\n")), /done/);
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
	assert.equal(runtime.ui.children.length, 6);
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

test("mycli shell settings selector updates local visual settings", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
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
	assert.equal(runtime.getState().settings?.hideThinking, false);
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
	terminal.input?.("\x1b[B");
	terminal.input?.("\r");
	await setTimeout(25);
	assert.equal(selected, "session-b");
	assert.equal(runtime.getState().footer.sessionName, "session-b");
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

test("mycli shell runtime does not interrupt running turns with ctrl c", async () => {
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
	runtime.editor.setText("draft");
	terminal.input?.("\x03");
	await setTimeout(25);

	assert.equal(interrupted, 0);
	assert.equal(runtime.editor.getText(), "");

	terminal.input?.("\x03");
	await setTimeout(25);

	assert.equal(interrupted, 0);
	assert.match(stripAnsi(runtime.ui.render(100).join("\n")), /Press Ctrl\+C again to exit/);
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
	await runtime.editor.onSubmit?.("/subagents child-session");
	await runtime.editor.onSubmit?.("/trace-jsonl");

	assert.deepEqual(submitted, []);
	assert.deepEqual(commands, ["/changes", "/subagents child-session", "/trace-jsonl"]);
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

	await assertCommandVisible(/\/subagents/);
	await assertCommandVisible(/\/changes/);
	await assertCommandVisible(/\/trace/);
	await assertCommandVisible(/\/session-maintenance/);
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

	terminal.input?.("\x1b[5~");
	await setTimeout(25);
	assert.ok(runtime.getTranscriptScrollOffset() > 0);
	assert.match(stripAnsi(terminal.output), /message 1[0-8]/);

	terminal.input?.("\x1b[6~");
	await setTimeout(25);
	assert.equal(runtime.getTranscriptScrollOffset(), 0);
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
	assert.match(output, /mycli/);
	assert.match(output, /Message mycli/);
	assert.match(output, /deepseek-v4-flash/);
	assert.match(output, /message 1[0-9]/);
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

	terminal.input?.("\x1b[A");
	await setTimeout(25);
	assert.ok(runtime.getTranscriptScrollOffset() > 0);

	terminal.input?.("\x1b[B");
	await setTimeout(25);
	assert.equal(runtime.getTranscriptScrollOffset(), 0);
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
			"--glob",
			"!imported-ui/**",
		],
		{ cwd: new URL("..", import.meta.url), encoding: "utf8" },
	);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.equal(result.stdout, "");
});

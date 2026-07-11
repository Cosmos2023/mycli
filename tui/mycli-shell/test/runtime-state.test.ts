import assert from "node:assert/strict";
import test from "node:test";
import {
	initialRuntimeState,
	projectRuntimeState,
	reduceRuntimeEvent,
	runtimeStateFromBootstrap,
	runtimeStateFromTranscript,
	runtimeStateWithCommandResult,
	runtimeStateWithUserMessage,
	sessionsFromResult,
	sessionTreeFromResult,
	settingsFromResult,
	runtimeStateWithSettings,
	resourcesFromResult,
	type RuntimeShellState,
} from "../src/adapters/runtime-state.ts";

test("runtime adapter projects bootstrap and transcript into mycli shell state", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromBootstrap(state, {
		session_id: "s1",
		session_title: "demo",
		workspace: "/repo",
		model: "deepseek-v4-flash",
		provider: "deepseek/openai",
		status: { trust: { state: "trusted", workspace: "/repo" } },
		welcome: { startup_mark: { text: "mycli" }, workspace: "/repo" },
	});
	state = runtimeStateFromTranscript(state, {
		items: [
			{ id: "u1", type: "user", text: "hello", folded: false, metadata: {} },
			{ id: "r1", type: "reasoning", text: "think", folded: true, metadata: {} },
			{ id: "a1", type: "assistant_final", text: "world", folded: false, metadata: {} },
			{
				id: "t1",
				type: "tool_summary",
				text: "Read /repo/word.txt",
				folded: true,
				metadata: { tool_name: "Read", path: "/repo/word.txt", success: true, duration_s: 1.2 },
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.footer.cwd, "/repo");
	assert.equal(shell.footer.model, "deepseek-v4-flash");
	assert.equal(shell.footer.trust, "trusted");
	assert.equal(shell.messages.some((message) => message.role === "assistant" && message.thinking === "think"), true);
	assert.equal(shell.tools[0]?.name, "Read");
	assert.equal(shell.tools[0]?.args, "word.txt");
	assert.equal(shell.tools[0]?.status, "success");
	assert.equal(shell.tools[0]?.durationMs, 1200);
});

test("runtime adapter projects runtime-backed visual settings", () => {
	let state = initialRuntimeState();
	const settings = settingsFromResult({
		settings: {
			statusbar_mode: "compact",
			view_mode: "focus",
			theme: "light",
			hide_thinking: false,
			tool_details_default: "expanded",
			hardware_cursor: true,
			clear_on_shrink: false,
			terminal_progress: false,
			subagent_density: "detailed",
		},
	});
	state = runtimeStateWithSettings(state, settings);

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.settings, {
		statusbarMode: "compact",
		viewMode: "focus",
		theme: "light",
		hideThinking: false,
		toolDetailsDefault: "expanded",
		hardwareCursor: true,
		clearOnShrink: false,
		terminalProgress: false,
		subagentDensity: "detailed",
	});
});

test("runtime adapter applies tool detail default setting", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithSettings(state, { toolDetailsDefault: "expanded" });
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "t1",
				type: "tool_summary",
				text: "Read pyproject.toml\nline 2",
				metadata: { tool_name: "Read", path: "pyproject.toml", success: true },
			},
			{
				id: "b1",
				type: "tool_summary",
				text: "pytest -q\n1 passed",
				metadata: { tool_name: "Bash", command: "pytest -q", success: true },
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.tools[0]?.expanded, true);
	assert.equal(shell.bash[0]?.expanded, true);
});

test("runtime adapter keeps bash python source out of output preview", () => {
	let state = initialRuntimeState();
	const command = [
		"python <<'PY'",
		"from pathlib import Path",
		"for path in Path('.').glob('*.py'):",
		"    print(path)",
		"PY",
	].join("\n");
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "b1",
				type: "tool_summary",
				text: `Bash ${command}`,
				folded: true,
				metadata: { tool_name: "Bash", command, success: true },
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.bash[0]?.command, "python <<'PY' ... (5 lines)");
	assert.equal(shell.bash[0]?.outputPreview, undefined);
});

test("runtime adapter projects run shell aliases into bash blocks", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "b1",
				type: "tool_summary",
				text: "run_shell pytest -q",
				folded: true,
				metadata: { tool_name: "run_shell", command: "pytest -q", success: true },
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.bash[0]?.command, "pytest -q");
	assert.equal(shell.tools.length, 0);
});

test("runtime adapter projects runtime resources", () => {
	const resources = resourcesFromResult({
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
			{ id: "bad", type: "unknown", name: "ignored" },
		],
	});

	assert.deepEqual(resources, [
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
	]);
});

test("runtime adapter preserves interleaved transcript block order", () => {
	let state = initialRuntimeState();
	state = { ...state, workspace: "/repo" };
	state = runtimeStateFromTranscript(state, {
		items: [
			{ id: "u1", type: "user", text: "read word.txt", folded: false, metadata: {} },
			{
				id: "t1",
				type: "tool_summary",
				text: "Read /repo/word.txt",
				folded: true,
				metadata: { tool_name: "Read", path: "/repo/word.txt", success: true },
			},
			{ id: "a1", type: "assistant_final", text: "done", folded: false, metadata: {} },
		],
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(
		shell.transcript?.map((block) => block.kind),
		["message", "tool", "message"],
	);
	assert.equal(shell.transcript?.[0]?.kind === "message" ? shell.transcript[0].message.role : "", "user");
	assert.equal(shell.transcript?.[1]?.kind === "tool" ? shell.transcript[1].tool.name : "", "Read");
	assert.equal(shell.transcript?.[2]?.kind === "message" ? shell.transcript[2].message.text : "", "done");
});

test("runtime adapter reduces live gateway events", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithUserMessage(state, "hello");
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	state = reduceRuntimeEvent(state, "reasoning.delta", { client_turn_id: "c1", text: "thinking" });
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "hel" });
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "lo" });
	state = reduceRuntimeEvent(state, "tool.start", {
		client_turn_id: "c1",
		tool_id: "tool-1",
		call_id: "call-1",
		name: "Edit",
		args_preview: "src/a.py",
	});
	state = reduceRuntimeEvent(state, "tool.failed", {
		client_turn_id: "c1",
		tool_id: "tool-1",
		call_id: "call-1",
		name: "Edit",
		summary: "patch failed",
		error: "no match",
		success: false,
	});
	state = reduceRuntimeEvent(state, "message.complete", {
		client_turn_id: "c1",
		final: true,
		text: "final",
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.messages.some((message) => message.role === "user" && message.text === "hello"), true);
	assert.equal(shell.messages.some((message) => message.role === "assistant" && message.text === "final"), true);
	assert.equal(shell.tools[0]?.name, "Edit");
	assert.equal(shell.tools[0]?.status, "error");
	assert.equal(shell.tools[0]?.errorPreview, "no match");
});

test("runtime adapter renders compaction lifecycle as an in-turn block", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithUserMessage(state, "large task");
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	state = reduceRuntimeEvent(state, "compaction.started", {
		client_turn_id: "c1",
		source: "request_budget",
		before_tokens: 120000,
		max_tokens: 128000,
	});

	let shell = projectRuntimeState(state);
	assert.equal(state.turnRunning, true);
	assert.equal(state.liveStatus?.kind, "compaction");
	assert.equal(shell.tools[0]?.name, "Compact");
	assert.equal(shell.tools[0]?.status, "running");
	assert.match(shell.tools[0]?.outputPreview ?? "", /120,000/);

	state = reduceRuntimeEvent(state, "compaction.completed", {
		client_turn_id: "c1",
		source: "request_budget",
		status: "compressed",
		before_tokens: 120000,
		after_tokens: 42000,
		max_tokens: 128000,
		duration_s: 2.5,
	});

	shell = projectRuntimeState(state);
	assert.equal(state.turnRunning, true);
	assert.equal(shell.tools[0]?.name, "Compact");
	assert.equal(shell.tools[0]?.status, "success");
	assert.equal(shell.tools[0]?.durationMs, 2500);
	assert.match(shell.tools[0]?.outputPreview ?? "", /120,000 -> 42,000/);
});

test("runtime adapter projects approval requests into shell approval state", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "approval.request", {
		decision_id: "decision-1",
		preview: "file /tmp/image.jpg 2>&1",
		reason: "Shell command requires approval",
		tool_name: "Bash",
		worker_name: "explore",
		child_session_id: "demo:sub:turn_1:abcd1234",
		risk: "medium",
		risk_reason: "External command execution",
		content_preview: "line 1\nline 2",
		content_line_count: 2,
		content_truncated: false,
		diff: "@@ -1 +1 @@\n-old\n+new",
		options: [
			{ choice: "approve_once", label: "Allow once" },
			{ choice: "reject", label: "Reject" },
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.pendingApproval?.decisionId, "decision-1");
	assert.equal(shell.pendingApproval?.preview, "file /tmp/image.jpg 2>&1");
	assert.equal(shell.pendingApproval?.toolName, "Bash");
	assert.equal(shell.pendingApproval?.workerName, "explore");
	assert.equal(shell.pendingApproval?.childSessionId, "demo:sub:turn_1:abcd1234");
	assert.equal(shell.pendingApproval?.riskReason, "External command execution");
	assert.equal(shell.pendingApproval?.contentPreview, "line 1\nline 2");
	assert.equal(shell.pendingApproval?.contentLineCount, 2);
	assert.equal(shell.pendingApproval?.diffPreview, "@@ -1 +1 @@\n-old\n+new");
	assert.deepEqual(shell.pendingApproval?.options, [
		{ choice: "approve_once", label: "Allow once" },
		{ choice: "reject", label: "Reject" },
	]);
	assert.match(shell.pendingNotice ?? "", /Approval required/);
	assert.equal(shell.footer.liveState, "Waiting approval");
});

test("runtime adapter clears pending approval when approved turn starts", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "approval.request", {
		decision_id: "decision-1",
		preview: "python script.py",
		options: [
			{ choice: "approve_once", label: "Allow once" },
			{ choice: "reject", label: "Reject" },
		],
	});

	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "approval_1" });
	const shell = projectRuntimeState(state);

	assert.equal(state.pendingApproval, null);
	assert.equal(shell.pendingApproval, undefined);
	assert.equal(shell.footer.liveState, "Running");
});

test("runtime adapter projects subagent updates into dedicated transcript blocks", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "subagent.updated", {
		subagent: {
			run_id: "subagent-a1",
			child_session_id: "child-session-1",
			parent_turn_id: "turn-1",
			role: "explore",
			description: "Inspect Claude Code",
			status: "completed",
			mode: "background",
			summary: "Inspected Claude Code worker rendering and found permission badges.",
			path: "subagents/subagent-a1.json",
			tool_calls: 3,
			total_tokens: 1200,
			duration_ms: 3500,
		},
	});

	const shell = projectRuntimeState(state);
	const block = shell.transcript?.[0];

	assert.equal(block?.kind, "subagent");
	assert.equal(block?.kind === "subagent" ? block.subagent.role : "", "explore");
	assert.equal(block?.kind === "subagent" ? block.subagent.description : "", "Inspect Claude Code");
	assert.equal(block?.kind === "subagent" ? block.subagent.status : "", "completed");
	assert.equal(block?.kind === "subagent" ? block.subagent.mode : "", "background");
	assert.equal(block?.kind === "subagent" ? block.subagent.childSessionId : "", "child-session-1");
	assert.equal(block?.kind === "subagent" ? block.subagent.toolCalls : undefined, 3);
	assert.equal(block?.kind === "subagent" ? block.subagent.tokens : undefined, 1200);
	assert.equal(block?.kind === "subagent" ? block.subagent.durationMs : undefined, 3500);
	assert.match(block?.kind === "subagent" ? block.subagent.summary ?? "" : "", /permission badges/);
});

test("runtime adapter accumulates subagent progress updates", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "subagent.updated", {
		subagent: {
			run_id: "subagent-a1",
			child_session_id: "child-session-1",
			parent_turn_id: "turn-1",
			role: "explore",
			description: "Inspect auth bug",
			status: "running",
			mode: "sync",
			summary: "Read path=src/auth/session.py",
			progress: [{ kind: "tool_call", tool_name: "Read", summary: "Read path=src/auth/session.py" }],
		},
	});
	state = reduceRuntimeEvent(state, "subagent.updated", {
		subagent: {
			run_id: "subagent-a1",
			child_session_id: "child-session-1",
			parent_turn_id: "turn-1",
			role: "explore",
			description: "Inspect auth bug",
			status: "running",
			mode: "sync",
			summary: "Found token refresh logic",
			progress: [{ kind: "tool_result", tool_name: "Read", summary: "Found token refresh logic" }],
		},
	});

	const shell = projectRuntimeState(state);
	const block = shell.transcript?.[0];

	assert.equal(block?.kind, "subagent");
	assert.deepEqual(block?.kind === "subagent" ? block.subagent.progress?.map((item) => item.summary) : [], [
		"Read path=src/auth/session.py",
		"Found token refresh logic",
	]);
});

test("runtime adapter keeps tool calls between assistant text segments", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithUserMessage(state, "inspect then answer");
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "I'll inspect first." });
	state = reduceRuntimeEvent(state, "tool.start", {
		client_turn_id: "c1",
		tool_id: "tool-1",
		call_id: "call-1",
		name: "Read",
		args_preview: "word.txt",
	});
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "Done." });
	state = reduceRuntimeEvent(state, "message.complete", {
		client_turn_id: "c1",
		final: true,
		text: "I'll inspect first.Done.",
	});

	assert.equal(state.activeAssistantItemId, null);
	const shell = projectRuntimeState(state);

	assert.deepEqual(
		shell.transcript?.map((block) => {
			if (block.kind === "tool") return `tool:${block.tool.name}`;
			if (block.kind === "message") return `${block.message.role}:${block.message.text}`;
			return "bash";
		}),
		["user:inspect then answer", "assistant:I'll inspect first.", "tool:Read", "assistant:Done."],
	);
});

test("runtime adapter projects write content preview from tool call arguments", () => {
	let state = initialRuntimeState();
	state = { ...state, workspace: "/repo" };
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "write-call",
				type: "tool_summary",
				text: "Write /repo/docs/notes.md",
				folded: true,
				metadata: {
					tool_name: "Write",
					arguments: {
						file_path: "/repo/docs/notes.md",
						content: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
					},
					success: true,
					summary: "Wrote 86 bytes to /repo/docs/notes.md",
				},
			},
		],
	});

	const shell = projectRuntimeState(state);
	const tool = shell.tools[0];

	assert.equal(tool?.name, "Write");
	assert.equal(tool?.args, "docs/notes.md");
	assert.match(tool?.contentPreview ?? "", /line 1/);
	assert.equal(tool?.contentLineCount, 12);
	assert.equal(tool?.hiddenLineCount, 2);
	assert.equal(tool?.outputPreview, undefined);
});

test("runtime adapter projects live write content preview from lifecycle event", () => {
	let state = initialRuntimeState();
	state = { ...state, workspace: "/repo" };
	state = reduceRuntimeEvent(state, "tool.start", {
		client_turn_id: "c1",
		tool_id: "call-write-1",
		call_id: "call-write-1",
		name: "Write",
		args_preview: "file_path=docs/notes.md",
		content_preview: "line 1\nline 2",
		content_line_count: 2,
		content_truncated: false,
	});

	const shell = projectRuntimeState(state);
	const tool = shell.tools[0];

	assert.equal(tool?.name, "Write");
	assert.equal(tool?.contentPreview, "line 1\nline 2");
	assert.equal(tool?.contentLineCount, 2);
});

test("runtime adapter projects write_file content preview alias", () => {
	let state = initialRuntimeState();
	state = { ...state, workspace: "/repo" };
	state = reduceRuntimeEvent(state, "tool.start", {
		client_turn_id: "c1",
		tool_id: "call-write-1",
		call_id: "call-write-1",
		name: "write_file",
		args_preview: "file_path=docs/notes.md",
		content_preview: "line 1\nline 2",
		content_line_count: 2,
		content_truncated: false,
	});

	const shell = projectRuntimeState(state);
	const tool = shell.tools[0];

	assert.equal(tool?.name, "write_file");
	assert.equal(tool?.contentPreview, "line 1\nline 2");
	assert.equal(tool?.contentLineCount, 2);
	assert.equal(tool?.outputPreview, undefined);
});

test("runtime adapter projects mutation diff preview from raw payload", () => {
	let state = initialRuntimeState();
	state = { ...state, workspace: "/repo" };
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "edit-result",
				type: "tool_summary",
				text: "Edit /repo/app.py",
				folded: true,
				metadata: {
					tool_name: "Edit",
					raw_payload: {
						path: "/repo/app.py",
						diff: "@@ -1 +1 @@\n-old\n+new",
					},
					success: true,
					summary: "Edited /repo/app.py",
				},
			},
		],
	});

	const shell = projectRuntimeState(state);
	const tool = shell.tools[0];

	assert.equal(tool?.args, "app.py");
	assert.equal(tool?.diffPreview, "@@ -1 +1 @@\n-old\n+new");
	assert.equal(tool?.outputPreview, undefined);
});

test("runtime adapter projects proposed plan as a dedicated transcript block", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithUserMessage(state, "plan this");
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "I checked the repo." });
	state = reduceRuntimeEvent(state, "plan.proposed", {
		client_turn_id: "c1",
		text: "# Plan\n- Add parser\n- Render block",
		source: "assistant_message",
	});
	state = reduceRuntimeEvent(state, "message.complete", {
		client_turn_id: "c1",
		final: true,
		text: "I checked the repo.",
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(
		shell.transcript?.map((block) => block.kind),
		["message", "message", "plan"],
	);
	const plan = shell.transcript?.[2];
	assert.equal(plan?.kind === "plan" ? plan.plan.text : "", "# Plan\n- Add parser\n- Render block");
	assert.equal(plan?.kind === "plan" ? plan.plan.status : "", "proposed");
});

test("runtime adapter projects turn plan steps into active plan panel state", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.completed", {
		client_turn_id: "c1",
		assistant_message: "done",
		activity_events: [],
		progress_updates: [],
		plan_steps: [
			"completed: Inspect runtime state",
			"in_progress: Render active plan",
			"pending: Verify shell tests",
		],
		pending_decision: false,
		turn_state: "completed",
		usage: {},
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.activePlan, [
		{ id: "step-1", status: "completed", text: "Inspect runtime state" },
		{ id: "step-2", status: "in_progress", text: "Render active plan" },
		{ id: "step-3", status: "pending", text: "Verify shell tests" },
	]);
});

test("runtime adapter clears active plan when terminal turn completes every step", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan_steps: [
			"completed: Inspect runtime state",
			"in_progress: Render active plan",
		],
		source: "Plan",
	});
	state = reduceRuntimeEvent(state, "turn.completed", {
		client_turn_id: "c1",
		assistant_message: "done",
		activity_events: [],
		progress_updates: [],
		plan_steps: [
			"completed: Inspect runtime state",
			"completed: Render active plan",
		],
		pending_decision: false,
		turn_state: "completed",
		usage: {},
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.activePlan, undefined);
});

test("runtime adapter keeps active plan when terminal turn still has pending work", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.completed", {
		client_turn_id: "c1",
		assistant_message: "done",
		activity_events: [],
		progress_updates: [],
		plan_steps: [
			"completed: Inspect runtime state",
			"pending: Verify shell tests",
		],
		pending_decision: false,
		turn_state: "completed",
		usage: {},
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.activePlan, [
		{ id: "step-1", status: "completed", text: "Inspect runtime state" },
		{ id: "step-2", status: "pending", text: "Verify shell tests" },
	]);
});

test("runtime adapter updates active plan immediately from plan updated event", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan_steps: [
			"completed: Inspect runtime state",
			"in_progress: Render active plan",
			"pending: Verify shell tests",
		],
		source: "Plan",
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.activePlan, [
		{ id: "step-1", status: "completed", text: "Inspect runtime state" },
		{ id: "step-2", status: "in_progress", text: "Render active plan" },
		{ id: "step-3", status: "pending", text: "Verify shell tests" },
	]);
});

test("runtime adapter preserves rich active plan evidence from plan updated event", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan: {
			items: [
				{ id: "inspect", status: "completed", text: "Inspect runtime state" },
				{
					id: "verify",
					status: "in_progress",
					text: "Run focused tests",
					evidence: ["pytest targeted tests passed"],
				},
			],
		},
		source: "Plan",
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.activePlan, [
		{ id: "inspect", status: "completed", text: "Inspect runtime state" },
		{
			id: "verify",
			status: "in_progress",
			text: "Run focused tests",
			evidence: ["pytest targeted tests passed"],
		},
	]);
});

test("runtime adapter appends only final assistant suffix after a tool boundary", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithUserMessage(state, "inspect then answer");
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "I'll inspect first." });
	state = reduceRuntimeEvent(state, "tool.start", {
		client_turn_id: "c1",
		tool_id: "tool-1",
		call_id: "call-1",
		name: "Read",
		args_preview: "word.txt",
	});
	state = reduceRuntimeEvent(state, "message.complete", {
		client_turn_id: "c1",
		final: true,
		text: "I'll inspect first.Done.",
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(
		shell.transcript?.map((block) => {
			if (block.kind === "tool") return `tool:${block.tool.name}`;
			if (block.kind === "message") return `${block.message.role}:${block.message.text}`;
			return "bash";
		}),
		["user:inspect then answer", "assistant:I'll inspect first.", "tool:Read", "assistant:Done."],
	);
});

test("runtime adapter preserves multiple assistant and tool segments in one turn", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithUserMessage(state, "do two checks");
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "First." });
	state = reduceRuntimeEvent(state, "tool.start", {
		client_turn_id: "c1",
		tool_id: "tool-1",
		call_id: "call-1",
		name: "Read",
		args_preview: "a.txt",
	});
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "Second." });
	state = reduceRuntimeEvent(state, "tool.start", {
		client_turn_id: "c1",
		tool_id: "tool-2",
		call_id: "call-2",
		name: "Grep",
		args_preview: "needle",
	});
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "Done." });
	state = reduceRuntimeEvent(state, "message.complete", {
		client_turn_id: "c1",
		final: true,
		text: "First.Second.Done.",
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(
		shell.transcript?.map((block) => {
			if (block.kind === "tool") return `tool:${block.tool.name}`;
			if (block.kind === "message") return `${block.message.role}:${block.message.text}`;
			return "bash";
		}),
		["user:do two checks", "assistant:First.", "tool:Read", "assistant:Second.", "tool:Grep", "assistant:Done."],
	);
});

test("runtime adapter opens a new assistant block after interleaved reasoning and tools", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	const assistantId = state.activeAssistantItemId;
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "hel" });
	state = reduceRuntimeEvent(state, "reasoning.delta", { client_turn_id: "c1", text: "thinking" });
	state = reduceRuntimeEvent(state, "tool.start", {
		client_turn_id: "c1",
		tool_id: "tool-1",
		call_id: "call-1",
		name: "Read",
		args_preview: "word.txt",
	});
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "lo" });

	const assistantItems = state.transcript.filter((item) => item.type === "assistant_stream" || item.type === "assistant_final");

	assert.equal(assistantItems.length, 2);
	assert.equal(assistantItems[0]?.id, assistantId);
	assert.equal(assistantItems[0]?.type, "assistant_final");
	assert.equal(assistantItems[0]?.text, "hel");
	assert.equal(assistantItems[1]?.type, "assistant_stream");
	assert.equal(assistantItems[1]?.text, "lo");
});

test("runtime adapter attaches live reasoning to active assistant without extra assistant block", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	state = reduceRuntimeEvent(state, "message.delta", { client_turn_id: "c1", text: "hello" });
	state = reduceRuntimeEvent(state, "reasoning.delta", { client_turn_id: "c1", text: "thinking" });

	const shell = projectRuntimeState(state);
	const assistantMessages = shell.messages.filter((message) => message.role === "assistant");

	assert.equal(assistantMessages.length, 1);
	assert.equal(assistantMessages[0]?.text, "hello");
	assert.equal(assistantMessages[0]?.thinking, "thinking");
	assert.equal(shell.transcript?.some((block) => block.id === "live-reasoning"), false);
});

test("runtime adapter treats mirrored thinking delta as alias without duplicating reasoning", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	state = reduceRuntimeEvent(state, "reasoning.delta", { client_turn_id: "c1", text: "thinking" });
	state = reduceRuntimeEvent(state, "thinking.delta", { client_turn_id: "c1", text: "thinking" });

	const reasoningItems = state.transcript.filter((item) => item.type === "reasoning");

	assert.equal(reasoningItems.length, 1);
	assert.equal(reasoningItems[0]?.text, "thinking");
});

test("runtime adapter keeps ordinary running status out of pending transcript area", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "c1" });
	state = reduceRuntimeEvent(state, "status.update", { state: "running", text: "Thinking" });

	const shell = projectRuntimeState(state);

	assert.equal(shell.pendingNotice, undefined);
	assert.equal(shell.footer.liveState, "Thinking");
});

test("runtime adapter syncs backend message queues", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		steering: ["steer now"],
		follow_up: ["later"],
	});

	let shell = projectRuntimeState(state);

	assert.equal(shell.footer.queueCount, 2);
	assert.equal(shell.footer.steeringQueueCount, 1);
	assert.equal(shell.footer.followUpQueueCount, 1);

	state = reduceRuntimeEvent(state, "status.changed", {
		model: "gpt-5.4",
		provider: "openai/responses",
		turn_running: false,
		queued_steering: [],
		queued_follow_up: [],
		trust: { state: "trusted", workspace: "/repo" },
	});
	shell = projectRuntimeState(state);

	assert.equal(shell.footer.queueCount, 0);
	assert.equal(shell.footer.steeringQueueCount, 0);
	assert.equal(shell.footer.followUpQueueCount, 0);
	assert.equal(shell.footer.liveState, "Idle");
});

test("runtime adapter syncs typed backend message queues", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		steering_items: [{ message: "steer with image", local_images: [{ path: "/tmp/a.png" }] }],
		follow_up_items: [{ text: "follow later" }],
		has_pending_input: true,
		activity: {
			kind: "pending_input",
			has_pending_input: true,
			steering_count: 1,
			follow_up_count: 1,
		},
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.footer.queueCount, 2);
	assert.equal(shell.footer.steeringQueueCount, 1);
	assert.equal(shell.footer.followUpQueueCount, 1);
	assert.equal(shell.footer.hasPendingInput, true);
	assert.equal(shell.footer.queueActivity, "pending_input");
});

test("runtime adapter hides internal task notifications from visible queues and transcript", () => {
	let state = initialRuntimeState();
	const notification = [
		"<task-notification>",
		"<task-id>child-session</task-id>",
		"<task-type>local_agent</task-type>",
		"<status>completed</status>",
		"<summary>Agent completed</summary>",
		"</task-notification>",
	].join("\n");
	state = runtimeStateFromTranscript(state, {
		items: [
			{ id: "q1", type: "user", text: notification, folded: false, metadata: { queued: true, queue_kind: "steering" } },
			{ id: "u1", type: "user", text: "visible prompt", folded: false, metadata: {} },
		],
	});
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		steering: [notification],
		follow_up: ["visible follow-up"],
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.messages.map((message) => message.text), ["visible prompt"]);
	assert.deepEqual(shell.transcript?.map((block) => (block.kind === "message" ? block.message.text : "")), ["visible prompt"]);
	assert.equal(shell.footer.queueCount, 1);
	assert.equal(shell.footer.steeringQueueCount, 0);
	assert.equal(shell.footer.followUpQueueCount, 1);
});

test("runtime adapter projects thinking effort into footer and current model", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "status.changed", {
		model: "gpt-5.4",
		provider: "openai/responses",
		thinking_effort: "high",
		reasoning_effort: "high",
		trust: { state: "trusted", workspace: "/repo" },
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.footer.reasoningLevel, "high");
	assert.equal(shell.currentModel?.thinkingLevel, "high");
	assert.equal(shell.models?.[0]?.thinkingLevel, "high");
});

test("runtime adapter handles command results and session lists", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithCommandResult(state, "/status", { lines: ["ok"] });
	const shell = projectRuntimeState(
		state,
		sessionsFromResult({
			sessions: [
				{
					id: "s1",
					title: "One",
					cwd: "/repo",
					created_at: "2026-06-17T01:00:00Z",
					last_active: "2026-06-18T01:00:00Z",
					message_count: 7,
					first_message: "Fix the TUI",
					all_messages_text: "Fix the TUI session picker",
					parent_session_id: "root",
					named: true,
					current: false,
				},
			],
		}),
	);

	assert.equal(shell.messages.some((message) => message.text === "ok"), true);
	assert.equal(shell.sessions?.[0]?.id, "s1");
	assert.equal(shell.sessions?.[0]?.title, "One");
	assert.equal(shell.sessions?.[0]?.created, "2026-06-17T01:00:00Z");
	assert.equal(shell.sessions?.[0]?.lastActive, "2026-06-18T01:00:00Z");
	assert.equal(shell.sessions?.[0]?.messageCount, 7);
	assert.equal(shell.sessions?.[0]?.firstMessage, "Fix the TUI");
	assert.equal(shell.sessions?.[0]?.allMessagesText, "Fix the TUI session picker");
	assert.equal(shell.sessions?.[0]?.parentSessionId, "root");
	assert.equal(shell.sessions?.[0]?.named, true);
	assert.equal(shell.sessions?.[0]?.current, false);
});

test("runtime adapter projects usage and context commands as diagnostics", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithCommandResult(state, "/usage", {
		lines: [
			"[usage] session=session-a",
			"[usage] turns=3",
			"[usage] current_context_window input_tokens=42000 max_tokens=128000 usage_ratio=32.8% source=provider",
			"[usage] cumulative_usage input_tokens=100000 output_tokens=8000 total_tokens=108000 cache_read_tokens=90000 cache_write_tokens=5000",
			"[usage] estimated_cost=0.123",
		],
	});
	state = runtimeStateWithCommandResult(state, "/context", {
		lines: [
			"[context] budget input_tokens=91000 max_tokens=128000 usage_ratio=71.1% source=estimate",
			"[context] context_window fresh_tokens=12000 tool_result_tokens=30000 duplicate_tool_result_tokens=3000 evictable_tool_result_tokens=5000",
			"[context] compaction l1=2 before_tokens=90000 after_tokens=45000 ratio=50.0% last_decision=compact source=l4",
		],
	});

	const shell = projectRuntimeState(state);
	const usage = shell.transcript?.[0];
	const context = shell.transcript?.[1];

	assert.equal(usage?.kind, "diagnostic");
	assert.equal(usage?.kind === "diagnostic" ? usage.diagnostic.title : "", "Usage");
	assert.equal(
		usage?.kind === "diagnostic"
			? usage.diagnostic.metrics.some((metric) => metric.label === "Estimated cost" && metric.value === "0.123")
			: false,
		true,
	);
	assert.equal(context?.kind, "diagnostic");
	assert.equal(context?.kind === "diagnostic" ? context.diagnostic.title : "", "Context");
	assert.equal(
		context?.kind === "diagnostic"
			? context.diagnostic.metrics.some((metric) => metric.label === "Used" && metric.value === "71.1%")
			: false,
		true,
	);
	assert.equal(
		context?.kind === "diagnostic"
			? context.diagnostic.sections.some((section) => section.title === "Context composition")
			: false,
		true,
	);
});

test("runtime adapter projects session tree payload", () => {
	const tree = sessionTreeFromResult({
		session_id: "demo",
		active_path: ["demo"],
		nodes: [
			{
				id: "session:demo",
				kind: "session",
				session_id: "demo",
				parent_id: null,
				depth: 0,
				role: "session",
				summary: "Session A",
				timestamp: "2026-05-27T01:33:04Z",
				message_count: 4,
				active: true,
				on_active_path: true,
				preview: "Read pyproject.toml",
			},
			{
				id: "session:demo:message:0",
				kind: "message",
				session_id: "demo",
				parent_id: "session:demo",
				depth: 1,
				role: "user",
				summary: "Read pyproject.toml",
				message_index: 0,
				anchor_id: "hist_user",
				on_active_path: true,
				preview: "Read pyproject.toml",
			},
		],
	});

	assert.equal(tree.sessionId, "demo");
	assert.deepEqual(tree.activePath, ["demo"]);
	assert.equal(tree.nodes[0]?.id, "session:demo");
	assert.equal(tree.nodes[0]?.active, true);
	assert.equal(tree.nodes[1]?.messageIndex, 0);
	assert.equal(tree.nodes[1]?.parentId, "session:demo");
	assert.equal(tree.nodes[1]?.anchorId, "hist_user");
});

test("runtime adapter applies collaboration mode returned by command results", () => {
	let state: RuntimeShellState = { ...initialRuntimeState(), collaborationMode: "plan" };

	state = runtimeStateWithCommandResult(state, "/mode default", {
		lines: ["[mode] collaboration_mode=default"],
		mutated_mode: true,
		collaboration_mode: "default",
	});
	const shell = projectRuntimeState(state);

	assert.equal(state.collaborationMode, "default");
	assert.equal(shell.footer.liveState, "Idle");
	assert.equal(shell.messages.some((message) => message.text === "[mode] collaboration_mode=default"), true);
});

test("runtime adapter hides low-value successful tools outside verbose mode", () => {
	let state = initialRuntimeState();
	state = { ...state, workspace: "/repo" };
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "read",
				type: "tool_summary",
				text: "Read /repo/word.txt",
				folded: true,
				metadata: { tool_name: "Read", path: "/repo/word.txt", success: true },
			},
			{
				id: "edit",
				type: "tool_summary",
				text: "Edit /repo/word.txt",
				folded: true,
				metadata: { tool_name: "Edit", path: "/repo/word.txt", success: true },
			},
			{
				id: "grep-failed",
				type: "tool_summary",
				text: "Grep failed",
				folded: true,
				metadata: { tool_name: "Grep", query: "needle", success: false, error: "boom" },
			},
		],
	});

	const compact = projectRuntimeState(state);
	const verbose = projectRuntimeState({ ...state, viewMode: "verbose" });

	assert.equal(compact.tools.find((tool) => tool.id === "read")?.hidden, true);
	assert.equal(compact.tools.find((tool) => tool.id === "edit")?.hidden, false);
	assert.equal(compact.tools.find((tool) => tool.id === "grep-failed")?.hidden, false);
	assert.equal(verbose.tools.find((tool) => tool.id === "read")?.hidden, false);
});

test("shell lifecycle keeps background Bash running until terminal event", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "shell.started", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 1,
		command_preview: "uv run dev",
		background: true,
		process_state: "running_background",
		output_delta: "",
	});
	state = reduceRuntimeEvent(state, "shell.output", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 2,
		background: true,
		process_state: "running_background",
		output_delta: "ready\n",
		next_cursor: 6,
		output_chars: 6,
	});

	let shell = projectRuntimeState(state);
	assert.equal(shell.bash[0]?.status, "running");
	assert.equal(shell.bash[0]?.outputPreview, "ready\n");
	assert.equal(shell.footer.backgroundShellCount, 1);

	state = reduceRuntimeEvent(state, "shell.completed", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 3,
		background: true,
		process_state: "completed",
		terminal_state: "completed",
		exit_code: 0,
	});
	shell = projectRuntimeState(state);
	assert.equal(shell.bash[0]?.status, "success");
	assert.equal(shell.bash[0]?.terminalState, "completed");
	assert.equal(shell.footer.backgroundShellCount, 0);
});

test("background Bash tool completion cannot settle a live process", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "tool.start", {
		tool_id: "tool-1",
		call_id: "call-1",
		name: "Bash",
		args_preview: "uv run dev",
	});
	state = reduceRuntimeEvent(state, "shell.started", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 1,
		command_preview: "uv run dev",
		background: true,
		process_state: "running_background",
	});
	state = reduceRuntimeEvent(state, "tool.complete", {
		tool_id: "tool-1",
		call_id: "call-1",
		name: "Bash",
		success: true,
		raw_payload: { shell_id: "shell-1", status: "running" },
	});

	assert.equal(projectRuntimeState(state).bash[0]?.status, "running");
});

test("terminal shell state rejects later running events", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "shell.completed", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 5,
		background: true,
		process_state: "failed",
		terminal_state: "failed",
		exit_code: 2,
	});
	state = reduceRuntimeEvent(state, "shell.output", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 6,
		background: true,
		process_state: "running_background",
		output_delta: "late output",
	});

	const bash = projectRuntimeState(state).bash[0];
	assert.equal(bash?.status, "error");
	assert.equal(bash?.terminalState, "failed");
	assert.doesNotMatch(bash?.outputPreview ?? "", /late output/);
});

test("shell list and removal events preserve terminal transcript history", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "shell.completed", {
		shell_id: "shell-1",
		call_id: "call-1",
		sequence: 1,
		command_preview: "uv run test",
		background: true,
		process_state: "completed",
		terminal_state: "completed",
		exit_code: 0,
	});
	state = reduceRuntimeEvent(state, "shell.list.updated", {
		shell_id: "shell-1",
		sequence: 2,
		active_background_count: 3,
	});
	assert.equal(projectRuntimeState(state).footer.backgroundShellCount, 3);

	state = reduceRuntimeEvent(state, "shell.removed", {
		shell_id: "shell-1",
		sequence: 3,
	});
	assert.equal(state.backgroundShells["shell-1"], undefined);
	assert.equal(projectRuntimeState(state).bash[0]?.status, "success");
});

test("background shell bootstrap restores running state without reviving terminal cells", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromBootstrap(state, {
		session_id: "demo",
		workspace: "/repo",
		status: {},
		background_shells: [
			{
				shell_id: "shell-1",
				call_id: "call-1",
				command_preview: "uv run dev",
				background: true,
				status: "running",
				process_state: "running_background",
				output: "ready\n",
			},
		],
	});

	const shell = projectRuntimeState(state);
	assert.equal(shell.bash[0]?.status, "running");
	assert.equal(shell.bash[0]?.command, "uv run dev");
	assert.equal(state.backgroundShells["shell-1"]?.outputPreview, "ready\n");
	assert.equal(shell.footer.backgroundShellCount, 1);
});

test("shell output preview stays bounded with an omission marker", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "shell.output", {
		shell_id: "shell-1",
		sequence: 1,
		command_preview: "generate output",
		background: true,
		process_state: "running_background",
		output_delta: "x".repeat(12_000),
		output_chars: 12_000,
		omitted_output_chars: 2_000,
	});

	const preview = projectRuntimeState(state).bash[0]?.outputPreview ?? "";
	assert.ok(preview.length <= 10_000);
	assert.match(preview, /chars omitted/);
});

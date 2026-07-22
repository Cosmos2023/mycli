import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	initialRuntimeState,
	projectRuntimeState,
	reduceRuntimeEvent,
	runtimeStateFromBootstrap,
	runtimeStateFromTranscript,
	runtimeStateWithCommandResult,
	runtimeStateWithUserMessage,
	runtimeStateWithPendingSteer,
	runtimeStateWithSubmittingMessage,
	runtimeStateWithLocalFollowUp,
	runtimeStateRejectPendingSteer,
	popLastLocalFollowUp,
	nextLocalUserInput,
	sessionsFromResult,
	sessionTreeFromResult,
	settingsFromResult,
	runtimeStateWithSettings,
	resourcesFromResult,
	type RuntimeShellState,
} from "../src/adapters/runtime-state.ts";
import { canonicalToolName } from "../src/components/tool-display.ts";

test("canonical shell tool names preserve Shell and legacy Bash", () => {
	assert.equal(canonicalToolName("Shell"), "Shell");
	assert.equal(canonicalToolName("run_shell"), "Shell");
	assert.equal(canonicalToolName("Bash"), "Bash");
});

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

test("runtime adapter does not append the same transcript page twice", () => {
	const payload = {
		items: [
			{ id: "u1", type: "user", text: "hello", folded: false, metadata: {} },
			{ id: "a1", type: "assistant_final", text: "world", folded: false, metadata: {} },
		],
	};

	let state = runtimeStateFromTranscript(initialRuntimeState(), payload);
	state = runtimeStateFromTranscript(state, payload);

	assert.deepEqual(
		state.transcript.map((item) => item.id),
		["u1", "a1"],
	);
});

test("runtime adapter projects a resumed Skill name as its tool argument", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "skill-1",
				type: "tool_summary",
				text: "Skill",
				folded: false,
				metadata: {
					tool_name: "Skill",
					skill_name: "repository-analysis",
					success: true,
					output_preview: "Activated skill: repository-analysis",
				},
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.tools[0]?.name, "Skill");
	assert.equal(shell.tools[0]?.args, "repository-analysis");
});

test("runtime adapter prefers display envelope over conflicting legacy metadata", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "tool-1",
				type: "tool_summary",
				text: "legacy text",
				metadata: {
					tool_name: "Grep",
					path: "wrong-path",
					summary: "wrong summary",
					display: {
						target: "src: ToolResult",
						status: "success",
						summary: "12 matches",
						detail: "src/a.py:10: class ToolResult",
						metrics: { match_count: 12, duration_ms: 25 },
						presentation: "context",
					},
				},
			},
		],
	});

	const tool = projectRuntimeState(state).tools[0];
	assert.equal(tool?.args, "src: ToolResult");
	assert.equal(tool?.status, "success");
	assert.equal(tool?.summaryPreview, "12 matches");
	assert.equal(tool?.detailPreview, "src/a.py:10: class ToolResult");
	assert.equal(tool?.presentation, "context");
	assert.equal(tool?.durationMs, 25);
});

test("runtime adapter projects equal live and resumed display semantics", () => {
	const display = {
		target: "repository-analysis",
		status: "success",
		summary: "Activated",
		presentation: "skill",
	};
	const resumed = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [
			{
				id: "skill-resumed",
				type: "tool_summary",
				text: "Skill",
				metadata: { tool_name: "Skill", call_id: "skill-call", display },
			},
		],
	});
	const live = reduceRuntimeEvent(initialRuntimeState(), "tool.complete", {
		tool_id: "skill-live",
		call_id: "skill-call",
		name: "Skill",
		display,
	});

	const resumedTool = projectRuntimeState(resumed).tools[0];
	const liveTool = projectRuntimeState(live).tools[0];
	assert.deepEqual(
		{ ...liveTool, id: "stable" },
		{ ...resumedTool, id: "stable" },
	);
});

test("runtime adapter projects equal live and resumed file changes", () => {
	const display = {
		target: "src/app.py",
		status: "success",
		summary: "Updated",
		presentation: "mutation",
		file_changes: [
			{
				version: 1,
				kind: "update",
				path: "src/app.py",
				diff: "--- src/app.py:before\n+++ src/app.py:after\n@@ -1 +1 @@\n-old\n+new\n",
				added_lines: 1,
				removed_lines: 1,
				language: "py",
			},
		],
	};
	const resumed = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [
			{
				id: "edit-resumed",
				type: "tool_summary",
				text: "Edit",
				metadata: { tool_name: "Write", call_id: "call-edit", display },
			},
		],
	});
	const live = reduceRuntimeEvent(initialRuntimeState(), "tool.complete", {
		tool_id: "edit-live",
		call_id: "call-edit",
		name: "Write",
		display,
	});

	const resumedBlock = projectRuntimeState(resumed).transcript?.[0];
	const liveState = projectRuntimeState(live);
	const liveBlock = liveState.transcript?.[0];

	assert.equal(resumedBlock?.kind, "file_change");
	assert.equal(liveBlock?.kind, "file_change");
	assert.deepEqual(
		{ ...(liveBlock?.kind === "file_change" ? liveBlock.fileChange : {}), id: "stable" },
		{ ...(resumedBlock?.kind === "file_change" ? resumedBlock.fileChange : {}), id: "stable" },
	);
	assert.equal(liveState.tools.length, 0);
});

test("runtime adapter keeps running Write as a generic tool until completion", () => {
	const state = reduceRuntimeEvent(initialRuntimeState(), "tool.start", {
		tool_id: "write-running",
		call_id: "call-write-running",
		name: "Write",
		display: {
			target: "src/new.py",
			status: "running",
			summary: "Preparing change",
			presentation: "mutation",
		},
	});

	const shell = projectRuntimeState(state);
	assert.equal(shell.transcript?.[0]?.kind, "tool");
	assert.equal(shell.tools[0]?.status, "running");
});

test("runtime adapter falls back to legacy metadata for malformed display", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "legacy-read",
				type: "tool_summary",
				text: "Read src/app.py",
				metadata: {
					tool_name: "Read",
					path: "src/app.py",
					success: true,
					display: { status: 42, summary: ["invalid"] },
				},
			},
		],
	});

	assert.equal(projectRuntimeState(state).tools[0]?.args, "src/app.py");
});

test("runtime adapter accepts an empty display summary", () => {
	const state = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [
			{
				id: "external-running",
				type: "tool_summary",
				text: "External",
				metadata: {
					tool_name: "mcp__demo__run",
					display: {
						target: "job-1",
						status: "running",
						summary: "",
						presentation: "external",
					},
				},
			},
		],
	});

	const tool = projectRuntimeState(state).tools[0];
	assert.equal(tool?.args, "job-1");
	assert.equal(tool?.presentation, "external");
	assert.equal(tool?.status, "running");
});

test("runtime adapter sends shell display detail and metrics to the shell cell", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "shell-1",
				type: "tool_summary",
				text: "Shell",
				metadata: {
					tool_name: "Shell",
					call_id: "shell-call",
					display: {
						target: "pytest -q",
						status: "success",
						summary: "Exit 0",
						detail: "2 passed",
						metrics: { exit_code: 0, duration_ms: 125, shell_id: "shell-1" },
						presentation: "shell",
					},
				},
			},
		],
	});

	const shell = projectRuntimeState(state).bash[0];
	assert.equal(shell?.command, "pytest -q");
	assert.equal(shell?.outputPreview, "2 passed");
	assert.equal(shell?.exitCode, 0);
	assert.equal(shell?.shellId, "shell-1");
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

test("runtime adapter collapses resumed tools without overriding explicit fold state", () => {
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
			{
				id: "t2",
				type: "tool_summary",
				text: "Read README.md",
				folded: false,
				metadata: { tool_name: "Read", path: "README.md", success: true },
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.tools[0]?.expanded, false);
	assert.equal(shell.bash[0]?.expanded, false);
	assert.equal(shell.tools[1]?.expanded, true);
});

test("runtime adapter keeps expanded defaults for non-resumed tool items", () => {
	let state = runtimeStateWithSettings(initialRuntimeState(), { toolDetailsDefault: "expanded" });
	state = {
		...state,
		transcript: [
			{
				id: "live-tool",
				type: "tool_summary",
				text: "Read live.txt",
				metadata: { tool_name: "Read", path: "live.txt", success: true },
			},
		],
	};

	assert.equal(projectRuntimeState(state).tools[0]?.expanded, true);
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

test("runtime adapter coalesces legacy tool summary and detail on resume", () => {
	let state = initialRuntimeState();
	state = { ...state, workspace: "/repo" };
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "read-call",
				type: "tool_summary",
				text: "Read /repo/word.txt",
				folded: true,
				metadata: {
					tool_name: "Read",
					call_id: "call-read-1",
					path: "/repo/word.txt",
					status: "running",
				},
			},
			{
				id: "read-result",
				type: "tool_detail",
				text: "file contents",
				folded: true,
				metadata: {
					tool_name: "Read",
					call_id: "call-read-1",
					status: "done",
					success: true,
					output_preview: "file contents",
					duration_ms: 25,
				},
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.tools.length, 1);
	assert.equal(shell.tools[0]?.id, "read-call");
	assert.equal(shell.tools[0]?.status, "success");
	assert.equal(shell.tools[0]?.outputPreview, "file contents");
	assert.equal(shell.tools[0]?.durationMs, 25);
});

test("runtime adapter folds resumed ShellOutput rows into their Shell command", () => {
	const state = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [
			{
				id: "shell-command",
				type: "tool_summary",
				text: "echo started; sleep 3; echo done",
				metadata: {
					tool_name: "Shell",
					call_id: "shell-call",
					shell_id: "shell-1",
					command_preview: "echo started; sleep 3; echo done",
					background: true,
					process_state: "running_background",
					display: {
						status: "running",
						summary: "Running",
						target: "echo started; sleep 3; echo done",
						presentation: "shell",
					},
				},
			},
			{
				id: "shell-poll",
				type: "tool_summary",
				text: "ShellOutput",
				metadata: {
					tool_name: "ShellOutput",
					call_id: "poll-call",
					shell_id: "shell-1",
					process_state: "completed",
					terminal_state: "completed",
					exit_code: 0,
					display: {
						status: "success",
						summary: "Exit 0",
						detail: "started\ndone\n",
						target: "shell-1",
						presentation: "shell",
						metrics: { shell_id: "shell-1", exit_code: 0 },
					},
				},
			},
		],
	});

	const shell = projectRuntimeState(state);
	assert.equal(shell.bash.length, 1);
	assert.equal(shell.tools.some((tool) => tool.name === "ShellOutput"), false);
	assert.equal(shell.bash[0]?.command, "echo started; sleep 3; echo done");
	assert.equal(shell.bash[0]?.status, "success");
	assert.equal(shell.bash[0]?.outputPreview, "started\ndone\n");
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
	const failedEdit = shell.transcript?.find((block) => block.kind === "file_change");
	assert.equal(failedEdit?.kind, "file_change");
	if (failedEdit?.kind !== "file_change") return;
	assert.equal(failedEdit.fileChange.status, "error");
	assert.equal(failedEdit.fileChange.error, "no match");
	assert.equal(shell.tools.some((tool) => tool.name === "Edit"), false);
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
		persistent_rule_preview: '["python", "-m", "pytest"]',
		content_preview: "line 1\nline 2",
		content_line_count: 2,
		content_truncated: false,
		diff: "@@ -1 +1 @@\n-old\n+new",
		options: [
			{ choice: "approve_once", label: "Allow once" },
			{ choice: "reject", label: "Reject" },
			{ choice: "allow_session", label: "Allow for session" },
			{ choice: "always_allow", label: "Always allow" },
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.pendingApproval?.decisionId, "decision-1");
	assert.equal(shell.pendingApproval?.preview, "file /tmp/image.jpg 2>&1");
	assert.equal(shell.pendingApproval?.toolName, "Bash");
	assert.equal(shell.pendingApproval?.workerName, "explore");
	assert.equal(shell.pendingApproval?.childSessionId, "demo:sub:turn_1:abcd1234");
	assert.equal(shell.pendingApproval?.riskReason, "External command execution");
	assert.equal(shell.pendingApproval?.persistentRulePreview, '["python", "-m", "pytest"]');
	assert.equal(shell.pendingApproval?.contentPreview, "line 1\nline 2");
	assert.equal(shell.pendingApproval?.contentLineCount, 2);
	assert.equal(shell.pendingApproval?.diffPreview, "@@ -1 +1 @@\n-old\n+new");
	assert.deepEqual(shell.pendingApproval?.options, [
		{ choice: "approve_once", label: "Allow once" },
		{ choice: "reject", label: "Reject" },
		{ choice: "allow_session", label: "Allow for session" },
		{ choice: "always_allow", label: "Always allow" },
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

test("runtime adapter removes transient approval preview after a response", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "approval.request", {
		decision_id: "decision-1",
		preview: "echo duplicated command",
		options: [
			{ choice: "approve_once", label: "Allow once" },
			{ choice: "reject", label: "Reject" },
		],
	});

	assert.equal(projectRuntimeState(state).messages.some((message) => message.text === "echo duplicated command"), true);

	state = reduceRuntimeEvent(state, "approval.respond", {
		decision_id: "decision-1",
		choice: "approve_once",
	});

	const shell = projectRuntimeState(state);
	assert.equal(shell.pendingApproval, undefined);
	assert.equal(shell.messages.some((message) => message.text === "echo duplicated command"), false);
});

test("runtime adapter removes the transient clarification question after a response", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "clarify.request", {
		request_id: "request-1",
		tool_id: "tool-1",
		call_id: "call-1",
		tool_name: "AskUserQuestion",
		question: "Which implementation should we use?",
		options: [],
		multi_select: false,
	});

	assert.equal(projectRuntimeState(state).messages.some((message) => message.text === "Which implementation should we use?"), true);

	state = reduceRuntimeEvent(state, "clarify.respond", {
		request_id: "request-1",
		response: "Use the first implementation.",
	});

	const shell = projectRuntimeState(state);
	assert.equal(state.pendingClarification, null);
	assert.equal(shell.messages.some((message) => message.text === "Which implementation should we use?"), false);
});

test("runtime adapter clears stale clarification questions when the resumed turn starts", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "clarify.request", {
		request_id: "request-1",
		tool_id: "tool-1",
		call_id: "call-1",
		tool_name: "AskUserQuestion",
		question: "Which implementation should we use?",
		options: [],
		multi_select: false,
	});

	state = reduceRuntimeEvent(state, "turn.started", { client_turn_id: "clarification-1" });

	const shell = projectRuntimeState(state);
	assert.equal(state.pendingClarification, null);
	assert.equal(shell.messages.some((message) => message.text === "Which implementation should we use?"), false);
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

test("runtime adapter gives successful Task calls to the dedicated subagent UI", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "tool.start", {
		tool_id: "tool-task-1",
		call_id: "call-task-1",
		name: "Task",
		context: "Task",
	});
	state = reduceRuntimeEvent(state, "subagent.updated", {
		subagent: {
			run_id: "subagent-a1",
			child_session_id: "child-session-1",
			parent_turn_id: "turn-1",
			role: "explore",
			description: "Explore the tools subsystem",
			status: "running",
			mode: "background",
			summary: "Sub-agent started",
			tool_calls: 0,
		},
	});
	state = reduceRuntimeEvent(state, "tool.complete", {
		tool_id: "tool-task-1",
		call_id: "call-task-1",
		name: "Task",
		success: true,
		summary: "Sub-agent explore started in background.",
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.tools.some((tool) => tool.name === "Task"), false);
	assert.equal(shell.transcript?.filter((block) => block.kind === "subagent").length, 1);
});

test("runtime adapter hides successful Task rows when reloading history", () => {
	const state = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [
			{
				id: "task-success",
				type: "tool_detail",
				text: "Sub-agent explore started in background.",
				metadata: { tool_name: "Task", call_id: "call-task-1", success: true, status: "completed" },
			},
			{
				id: "task-failed",
				type: "tool_detail",
				text: "Task tool is unavailable.",
				metadata: { tool_name: "Task", call_id: "call-task-2", success: false, status: "failed", error: "Unavailable" },
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.tools.length, 1);
	assert.equal(shell.tools[0]?.errorPreview, "Unavailable");
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

test("runtime adapter upgrades a legacy Edit diff to a file change", () => {
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
	const block = shell.transcript?.[0];

	assert.equal(block?.kind, "file_change");
	if (block?.kind !== "file_change") return;
	assert.equal(block.fileChange.files[0]?.kind, "update");
	assert.equal(block.fileChange.files[0]?.path, "/repo/app.py");
	assert.equal(block.fileChange.files[0]?.diff, "@@ -1 +1 @@\n-old\n+new");
	assert.equal(shell.tools.length, 0);
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

test("runtime adapter does not synthesize Plan history from turn completion", () => {
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

	assert.deepEqual(shell.transcript, []);
	assert.equal(shell.footer.taskProgress, undefined);
});

test("runtime adapter appends every live Plan update", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan: {
			items: [
				{ id: "inspect", text: "Inspect runtime", status: "in_progress" },
			],
		},
		source: "Plan",
		completed: 0,
		total: 1,
	});
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan: {
			items: [
				{ id: "inspect", text: "Inspect runtime", status: "completed" },
			],
		},
		source: "Plan",
		completed: 1,
		total: 1,
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.transcript?.map((block) => block.kind), ["plan_update", "plan_update"]);
	assert.deepEqual(shell.footer.taskProgress, { completed: 1, total: 1 });
});

test("runtime adapter accepts compatibility Plan strings and preserves evidence", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan_steps: [
			"completed: Inspect runtime state",
			"in_progress: Run focused tests",
		],
		source: "Plan",
	});

	const shell = projectRuntimeState(state);
	const update = shell.transcript?.[0];

	assert.equal(update?.kind, "plan_update");
	assert.deepEqual(update?.kind === "plan_update" ? update.planUpdate.steps : [], [
		{ id: "step-1", status: "completed", text: "Inspect runtime state" },
		{ id: "step-2", status: "in_progress", text: "Run focused tests" },
	]);
});

test("runtime adapter restores all Plan updates and latest progress from transcript", () => {
	let state = initialRuntimeState();
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "plan-1",
				type: "plan_update",
				text: "Updated Plan",
				metadata: {
					source: "Plan",
					completed: 0,
					total: 1,
					items: [{ id: "inspect", text: "Inspect runtime", status: "in_progress" }],
				},
			},
			{
				id: "plan-2",
				type: "plan_update",
				text: "Updated Plan",
				metadata: {
					source: "Plan",
					completed: 1,
					total: 1,
					items: [{ id: "inspect", text: "Inspect runtime", status: "completed" }],
				},
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.transcript?.map((block) => block.kind), ["plan_update", "plan_update"]);
	assert.deepEqual(shell.footer.taskProgress, { completed: 1, total: 1 });
});

test("runtime adapter clears task progress for a valid empty Plan update", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan: {
			items: [
				{ id: "inspect", status: "in_progress", text: "Inspect runtime state" },
			],
		},
		source: "Plan",
	});
	state = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan: { items: [] },
		source: "Plan",
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.transcript?.map((block) => block.kind), ["plan_update", "plan_update"]);
	assert.equal(shell.footer.taskProgress, undefined);
});

test("runtime adapter ignores malformed Plan update payloads", () => {
	const state = initialRuntimeState();
	const next = reduceRuntimeEvent(state, "plan.updated", {
		client_turn_id: "c1",
		plan: { items: [{ id: "missing-text", status: "in_progress" }] },
	});

	assert.deepEqual(next, state);
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

test("runtime adapter ignores stale queue revisions", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		queue_revision: 4,
		queue_items: {
			pending_steers: [{ message: "new" }],
			rejected_steers: [],
			follow_ups: [],
		},
	});
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		queue_revision: 3,
		queue_items: {
			pending_steers: [{ message: "old" }],
			rejected_steers: [],
			follow_ups: [],
		},
	});

	assert.equal(state.queueRevision, 4);
	assert.deepEqual(state.queuedPendingSteers.map((item) => item.message), ["new"]);
});

test("session changes reset queue revision and hide internal notifications", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		queue_revision: 9,
		queue_items: {
			pending_steers: [{ message: "old", source: "user" }],
			rejected_steers: [],
			follow_ups: [],
		},
	});
	state = reduceRuntimeEvent(state, "session.changed", { session_id: "session-2" });
	state = reduceRuntimeEvent(state, "status.changed", {
		session_id: "session-2",
		queue_revision: 1,
		queue_items: {
			pending_steers: [
				{ message: "internal", source: "task_notification" },
				{ message: "visible", source: "user" },
			],
			rejected_steers: [],
			follow_ups: [],
		},
	});

	assert.equal(state.queueRevision, 1);
	assert.deepEqual(state.queuedPendingSteers.map((item) => item.message), ["visible"]);
});

test("runtime adapter tracks the active server turn until its matching terminal event", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.started", { turn_id: "turn-1" });
	state = reduceRuntimeEvent(state, "turn.completed", { turn_id: "turn-other" });
	assert.equal(state.activeTurnId, "turn-1");

	state = reduceRuntimeEvent(state, "turn.completed", { turn_id: "turn-1" });
	assert.equal(state.activeTurnId, null);
});

test("runtime adapter clears the matching interrupted server turn", () => {
	let state = reduceRuntimeEvent(initialRuntimeState(), "turn.started", {
		turn_id: "turn-1",
	});
	state = reduceRuntimeEvent(state, "turn.interrupted", {
		turn_id: "turn-1",
		message: "Interrupt requested",
	});

	assert.equal(state.activeTurnId, null);
	assert.equal(state.turnRunning, false);
	assert.equal(state.liveStatus?.state, "interrupted");
});

test("runtime adapter restores structured queue state from bootstrap", () => {
	const state = runtimeStateFromBootstrap(initialRuntimeState(), {
		session_id: "session-1",
		status: {
			turn_running: true,
			turn_id: "turn-1",
			queue_revision: 3,
			queue_items: {
				pending_steers: [{ message: "inspect" }],
				rejected_steers: [{ message: "after turn" }],
				follow_ups: [{ message: "later" }],
			},
		},
	});

	assert.equal(state.activeTurnId, "turn-1");
	assert.equal(state.queueRevision, 3);
	assert.deepEqual(state.queuedPendingSteers.map((item) => item.message), ["inspect"]);
	assert.deepEqual(state.queuedRejectedSteers.map((item) => item.message), ["after turn"]);
	assert.deepEqual(state.queuedFollowUpInputs.map((item) => item.message), ["later"]);
});

test("legacy queue migration imports user records into local queues once", () => {
	const payload = {
		session_id: "session-1",
		status: {
			queue_revision: 4,
			queue_items: {
				pending_steers: [{ queue_id: "queue-1", message: "inspect" }],
				rejected_steers: [],
				follow_ups: [{ queue_id: "queue-2", message: "later" }],
			},
		},
		legacy_user_queue_migration: {
			token: "migration-1",
			records: [
				{ queue_id: "queue-1", kind: "pending_steer", text: "inspect" },
				{
					queue_id: "queue-2",
					client_user_message_id: "client-2",
					kind: "follow_up",
					text: "later",
					local_images: [{ path: "/tmp/later.png", placeholder: "[image #1]" }],
				},
			],
		},
	};

	let state = runtimeStateFromBootstrap(initialRuntimeState(), payload);
	state = runtimeStateFromBootstrap(state, payload);

	assert.deepEqual(state.localRejectedSteers, [
		{ clientUserMessageId: "queue-1", message: "inspect", attachments: [] },
	]);
	assert.deepEqual(state.localFollowUps, [
		{
			clientUserMessageId: "client-2",
			message: "later",
			attachments: [{ path: "/tmp/later.png", placeholder: "[image #1]" }],
		},
	]);
	assert.deepEqual(state.queuedPendingSteers, []);
	assert.deepEqual(state.queuedRejectedSteers, []);
	assert.deepEqual(state.queuedFollowUpInputs, []);
});

test("runtime adapter projects pending steering through rejection and removal", () => {
	let state = reduceRuntimeEvent(initialRuntimeState(), "turn.queue.updated", {
		queue_revision: 1,
		queue_items: {
			pending_steers: [{ message: "redirect" }],
			rejected_steers: [],
			follow_ups: [],
		},
	});
	assert.deepEqual(projectRuntimeState(state).pendingInput, {
		pendingSteers: [{ text: "redirect", hasImages: false }],
		rejectedSteers: [],
		followUps: [],
	});

	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		queue_revision: 2,
		queue_items: {
			pending_steers: [],
			rejected_steers: [{ message: "redirect" }],
			follow_ups: [],
		},
	});
	assert.deepEqual(projectRuntimeState(state).pendingInput, {
		pendingSteers: [],
		rejectedSteers: [{ text: "redirect", hasImages: false }],
		followUps: [],
	});

	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		queue_revision: 3,
		queue_items: { pending_steers: [], rejected_steers: [], follow_ups: [] },
	});
	assert.equal(projectRuntimeState(state).pendingInput, undefined);
});

test("runtime adapter moves a consumed steer from pending input into transcript", () => {
	let state = reduceRuntimeEvent(initialRuntimeState(), "turn.queue.updated", {
		queue_revision: 1,
		queue_items: {
			pending_steers: [{ queue_id: "queue-1", message: "inspect output" }],
			rejected_steers: [],
			follow_ups: [],
		},
	});
	state = reduceRuntimeEvent(state, "turn.event", {
		client_turn_id: "client-1",
		phase: "queued_message_committed",
		kind: "queued_message_committed",
		text: "inspect output",
		metadata: {
			queue_id: "queue-1",
			queue_kind: "pending_steer",
			source: "user",
		},
	});
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		queue_revision: 2,
		queue_items: { pending_steers: [], rejected_steers: [], follow_ups: [] },
	});

	const shell = projectRuntimeState(state);
	assert.equal(shell.pendingInput, undefined);
	assert.deepEqual(shell.messages.map((message) => message.text), ["inspect output"]);
});

test("completed user item commits a pending steer exactly once", () => {
	let state = runtimeStateWithPendingSteer(initialRuntimeState(), {
		clientUserMessageId: "client-1",
		message: "inspect",
		attachments: [],
	});
	const payload = {
		turn_id: "turn-1",
		item: {
			id: "turn-1:user:client-1",
			type: "user_message",
			client_user_message_id: "client-1",
			content: "inspect",
			source: "steer",
		},
	};

	state = reduceRuntimeEvent(state, "item.completed", payload);
	state = reduceRuntimeEvent(state, "item.completed", payload);

	assert.equal(state.localPendingSteers.length, 0);
	assert.deepEqual(projectRuntimeState(state).messages.map((item) => item.text), ["inspect"]);
});

test("completed user item commits without local pending state", () => {
	let state = runtimeStateWithSubmittingMessage(initialRuntimeState(), {
		clientUserMessageId: "other-client",
		message: "other",
		attachments: [],
	});
	state = reduceRuntimeEvent(state, "item.completed", {
		turn_id: "turn-1",
		item: {
			id: "turn-1:user:client-1",
			type: "user_message",
			client_user_message_id: "client-1",
			content: "inspect",
			source: "steer",
		},
	});

	assert.deepEqual(projectRuntimeState(state).messages.map((item) => item.text), ["inspect"]);
	assert.equal(state.localSubmittingMessages.length, 1);
});

test("local rejected inputs precede follow-ups and edit-last restores latest follow-up", () => {
	let state = runtimeStateWithLocalFollowUp(initialRuntimeState(), {
		clientUserMessageId: "follow-1",
		message: "later one",
		attachments: [],
	});
	state = runtimeStateWithLocalFollowUp(state, {
		clientUserMessageId: "follow-2",
		message: "later two",
		attachments: [],
	});
	state = runtimeStateWithPendingSteer(state, {
		clientUserMessageId: "steer-1",
		message: "retry first",
		attachments: [],
	});
	state = runtimeStateRejectPendingSteer(state, "steer-1");

	assert.equal(nextLocalUserInput(state)?.kind, "rejected");
	assert.equal(nextLocalUserInput(state)?.input.message, "retry first");
	const popped = popLastLocalFollowUp(state);
	assert.equal(popped.input?.message, "later two");
	assert.deepEqual(popped.state.localFollowUps.map((item) => item.message), ["later one"]);
});

test("session changes clear transient local user input queues", () => {
	let state = runtimeStateWithPendingSteer(initialRuntimeState(), {
		clientUserMessageId: "steer-1",
		message: "inspect",
		attachments: [],
	});
	state = runtimeStateWithLocalFollowUp(state, {
		clientUserMessageId: "follow-1",
		message: "later",
		attachments: [],
	});
	state = reduceRuntimeEvent(state, "session.changed", { session_id: "session-2" });

	assert.deepEqual(state.localPendingSteers, []);
	assert.deepEqual(state.localRejectedSteers, []);
	assert.deepEqual(state.localFollowUps, []);
	assert.deepEqual(state.localSubmittingMessages, []);
});

test("gateway steering retries a turn mismatch with stable user identity", () => {
	const source = readFileSync(new URL("../src/gateway.ts", import.meta.url), "utf8");
	const steeringBody = source.match(/async function queueSteeringTurn\([\s\S]*?\n\}/)?.[0] ?? "";

	assert.match(steeringBody, /client_user_message_id:\s*input\.clientUserMessageId/);
	assert.match(steeringBody, /let expectedTurnId = runtimeState\.activeTurnId/);
	assert.match(steeringBody, /expected_turn_id:\s*expectedTurnId/);
	assert.match(steeringBody, /attempt < 2/);
	assert.match(steeringBody, /error\.code === "turn_id_mismatch"/);
	assert.match(steeringBody, /error\.data\.actual_turn_id/);
	assert.match(steeringBody, /expectedTurnId = actualTurnId/);
	assert.match(steeringBody, /runtimeStateWithPendingSteer/);
	assert.match(steeringBody, /runtimeStateRejectPendingSteer/);
	assert.match(source, /activeTurnId:\s*turnId \?\? runtimeState\.activeTurnId/);
	assert.match(source, /if \(backendTurnBusy\) \{\s*setRuntimeState\(\{/);
	assert.match(source, /event\.method === "status\.changed" && event\.params\.turn_running === false/);
	assert.doesNotMatch(source, /event\.method === "status\.changed" && backendTurnBusy/);
	assert.doesNotMatch(source, /queuedSteeringTurns|queuedFollowUpTurns/);
	assert.doesNotMatch(source, /send\("turn\.follow_up"/);
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
	assert.deepEqual(shell.pendingInput, {
		pendingSteers: [{ text: "steer with image", hasImages: true }],
		rejectedSteers: [],
		followUps: [{ text: "follow later", hasImages: false }],
	});
});

test("runtime adapter projects typed queue items from status bootstrap", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "status.changed", {
		model: "gpt-5.4",
		provider: "openai/responses",
		turn_running: true,
		queued_steering: ["inspect current output"],
		queued_follow_up: ["summarize afterward"],
		queued_steering_items: [
			{ message: "inspect current output", local_images: [{ path: "/tmp/a.png" }] },
		],
		queued_follow_up_items: [{ message: "summarize afterward" }],
		trust: { state: "trusted", workspace: "/repo" },
	});

	const shell = projectRuntimeState(state);

	assert.deepEqual(shell.pendingInput, {
		pendingSteers: [{ text: "inspect current output", hasImages: true }],
		rejectedSteers: [],
		followUps: [{ text: "summarize afterward", hasImages: false }],
	});
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
	assert.deepEqual(shell.pendingInput, {
		pendingSteers: [],
		rejectedSteers: [],
		followUps: [{ text: "visible follow-up", hasImages: false }],
	});
});

test("runtime adapter hides task-notification-only pending input", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "turn.queue.updated", {
		steering_items: [{ message: "<task-notification>done</task-notification>" }],
		follow_up_items: [],
		steering: ["<task-notification>done</task-notification>"],
		follow_up: [],
		has_pending_input: true,
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.pendingInput, undefined);
	assert.equal(shell.footer.queueCount, 0);
	assert.equal(shell.footer.steeringQueueCount, 0);
	assert.equal(shell.footer.followUpQueueCount, 0);
	assert.equal(shell.footer.hasPendingInput, false);
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

test("runtime adapter upserts structured command results by stable id", () => {
	const result = {
		result_id: "command:stable",
		display: {
			version: 1,
			kind: "list",
			command: "/tools",
			title: "Tools",
			severity: "info",
			rows: [{ key: "Read", label: "Read", values: ["file"] }],
		},
		lines: ["Tools", "Read  file"],
	};
	let state = runtimeStateWithCommandResult(initialRuntimeState(), "/tools", result);
	state = runtimeStateWithCommandResult(state, "/tools", {
		...result,
		lines: ["Tools", "Read  file", "Shell  shell"],
	});

	assert.equal(state.transcript.filter((item) => item.id === "command:stable").length, 1);
	const block = projectRuntimeState(state).transcript?.[0];
	assert.equal(block?.kind, "command_result");
	assert.equal(
		block?.kind === "command_result" ? block.commandResult.display.rows[0]?.label : "",
		"Read",
	);
});

test("runtime adapter ignores resumed command results but renders live results", () => {
	const display = {
		version: 1,
		kind: "notice",
		command: "/undo",
		title: "Undo complete",
		severity: "success",
		summary: "Restored app.py",
	};
	let state = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [
			{
				id: "command:resume",
				type: "command_result",
				text: "Restored app.py",
				folded: false,
				metadata: { command: "/undo", display, model_visible: false },
			},
		],
	});
	assert.deepEqual(state.transcript, []);

	state = runtimeStateWithCommandResult(state, "/undo", {
		result_id: "command:resume",
		display,
		lines: ["Restored app.py"],
	});

	assert.equal(state.transcript.filter((item) => item.id === "command:resume").length, 1);
	assert.deepEqual(projectRuntimeState(state).transcript?.map((block) => block.kind), ["command_result"]);
});

test("runtime adapter projects ps history into a background terminals block", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithCommandResult(state, "/ps", {
		command_kind: "background_shells",
		processes: [
			{
				shell_id: "shell-1",
				command_preview: "uv run dev",
				output: "starting\nready\n",
			},
		],
		lines: [],
	});

	const block = projectRuntimeState(state).transcript?.at(-1);

	assert.equal(block?.kind, "background_terminals");
	assert.deepEqual(
		block?.kind === "background_terminals" ? block.backgroundTerminals.processes : [],
		[
			{
				shellId: "shell-1",
				commandPreview: "uv run dev",
				recentOutput: ["starting", "ready"],
			},
		],
	);
});

test("runtime adapter leaves unstructured legacy command lines as plain messages", () => {
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

	assert.deepEqual(shell.transcript?.map((block) => block.kind), ["message", "message"]);
	assert.match(shell.messages[0]?.text ?? "", /^\[usage\] session=session-a/);
	assert.match(shell.messages[1]?.text ?? "", /^\[context\] budget/);
});

test("runtime adapter keeps malformed resumed legacy output exact", () => {
	const text = '[tool] Read description="unterminated';
	const state = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [
			{
				id: "legacy-malformed",
				type: "system_notice",
				text,
				folded: false,
				metadata: { command: "/tools" },
			},
		],
	});

	const shell = projectRuntimeState(state);
	assert.deepEqual(shell.transcript?.map((block) => block.kind), ["message"]);
	assert.equal(shell.messages[0]?.text, text);
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
		shell_kind: "powershell",
		shell_edition: "core",
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
	assert.equal(shell.bash[0]?.toolName, "Shell");
	assert.equal(shell.bash[0]?.shellKind, "powershell");
	assert.equal(shell.bash[0]?.shellEdition, "core");
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

test("ShellOutput updates the original Shell card without creating a polling card", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "tool.start", {
		tool_id: "shell-tool",
		call_id: "shell-call",
		name: "Shell",
		args_preview: "echo started; sleep 3; echo done",
		display: {
			status: "running",
			summary: "Running",
			presentation: "shell",
			target: "echo started; sleep 3; echo done",
		},
	});
	state = reduceRuntimeEvent(state, "shell.started", {
		shell_id: "shell-1",
		call_id: "shell-call",
		sequence: 1,
		command_preview: "echo started; sleep 3; echo done",
		background: true,
		process_state: "running_background",
	});
	state = reduceRuntimeEvent(state, "tool.start", {
		tool_id: "poll-tool",
		call_id: "poll-call",
		name: "ShellOutput",
		args_preview: "shell_id=shell-1",
	});
	state = reduceRuntimeEvent(state, "tool.complete", {
		tool_id: "poll-tool",
		call_id: "poll-call",
		name: "ShellOutput",
		success: true,
		raw_payload: {
			shell_id: "shell-1",
			status: "running",
			process_state: "running_background",
			output: "started\n",
		},
		display: {
			status: "running",
			summary: "Running",
			detail: "started\n",
			presentation: "shell",
			target: "shell-1",
			metrics: { shell_id: "shell-1" },
		},
	});

	let shell = projectRuntimeState(state);
	assert.equal(shell.bash.length, 1);
	assert.equal(shell.tools.some((tool) => tool.name === "ShellOutput"), false);
	assert.equal(shell.bash[0]?.command, "echo started; sleep 3; echo done");
	assert.equal(shell.bash[0]?.outputPreview, "started\n");

	state = reduceRuntimeEvent(state, "shell.completed", {
		shell_id: "shell-1",
		call_id: "shell-call",
		sequence: 2,
		background: true,
		process_state: "completed",
		terminal_state: "completed",
		exit_code: 0,
	});
	shell = projectRuntimeState(state);
	assert.equal(shell.bash.length, 1);
	assert.equal(shell.bash[0]?.status, "success");
	assert.equal(shell.bash[0]?.terminalState, "completed");
});

test("WriteStdin poll merges into yielded Shell without a second card", () => {
	let state = initialRuntimeState();
	state = reduceRuntimeEvent(state, "shell.started", {
		shell_id: "shell-1",
		call_id: "call-shell",
		sequence: 1,
		command_preview: "pytest -q",
		background: false,
		process_state: "running_foreground",
		transport: "pipe",
		tty: false,
	});
	state = reduceRuntimeEvent(state, "shell.list.updated", {
		shell_id: "shell-1",
		sequence: 2,
		background: true,
		yielded: true,
		process_state: "running_background",
		active_background_count: 1,
	});
	state = reduceRuntimeEvent(state, "tool.complete", {
		name: "WriteStdin",
		call_id: "call-poll",
		raw_payload: {
			session_id: "shell-1",
			output: "50% complete",
			transport: "pipe",
			tty: false,
			background: true,
			yielded: true,
			process_state: "running_background",
		},
	});

	const shell = projectRuntimeState(state);
	const bashBlocks = shell.transcript?.filter((block) => block.kind === "bash") ?? [];

	assert.equal(bashBlocks.length, 1);
	assert.equal(bashBlocks[0]?.bash.background, true);
	assert.equal(bashBlocks[0]?.bash.yielded, true);
	assert.equal(bashBlocks[0]?.bash.transport, "pipe");
	assert.equal(bashBlocks[0]?.bash.tty, false);
	assert.match(bashBlocks[0]?.bash.outputPreview ?? "", /50% complete/);
	assert.equal(shell.tools.some((tool) => tool.name === "WriteStdin"), false);
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

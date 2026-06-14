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
	const shell = projectRuntimeState(state, sessionsFromResult({ sessions: [{ id: "s1", title: "One", cwd: "/repo" }] }));

	assert.equal(shell.messages.some((message) => message.text === "ok"), true);
	assert.equal(shell.sessions?.[0]?.id, "s1");
	assert.equal(shell.sessions?.[0]?.title, "One");
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

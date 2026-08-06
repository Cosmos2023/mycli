import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SEND_MESSAGE_TOOL_DEFINITION,
	SendMessageTool,
	SUBAGENT_OUTPUT_TOOL_DEFINITION,
	SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS,
	SubagentManagementService,
	SubagentOutputTool,
	SubagentProfileRegistry,
	TASK_TOOL_DEFINITION,
	TaskTool,
	type SubagentControlContract,
} from "../src/index.ts";

test("Task SubagentOutput and SendMessage definitions remain stable", () => {
	assert.deepEqual([
		TASK_TOOL_DEFINITION.name,
		SUBAGENT_OUTPUT_TOOL_DEFINITION.name,
		SEND_MESSAGE_TOOL_DEFINITION.name,
	], ["Task", "SubagentOutput", "SendMessage"]);
	assert.deepEqual(TASK_TOOL_DEFINITION.inputSchema.required, ["profile", "prompt"]);
	assert.deepEqual(SUBAGENT_OUTPUT_TOOL_DEFINITION.inputSchema.required, ["child_session_id"]);
	assert.deepEqual(SEND_MESSAGE_TOOL_DEFINITION.inputSchema.required, ["child_session_id", "message"]);
});

test("Task maps foreground and background controller results", async () => {
	const calls: unknown[] = [];
	const control = controlFixture({
		start: async (input) => {
			calls.push(input);
			return input.mode === "background"
				? {
					status: "running" as const,
					taskId: "task-bg",
					childSessionId: "child-bg",
					summary: "Subagent started in background",
				}
				: {
					status: "completed" as const,
					taskId: "task-fg",
					childSessionId: "child-fg",
					summary: "Subagent completed",
					report: "x".repeat(SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS * 2),
				};
		},
	});
	const tool = new TaskTool({ control });

	const background = await tool.execute({ profile: "explore", prompt: "Inspect." }, execution());
	const foreground = await tool.execute({
		profile: "review",
		prompt: "Review.",
		mode: "foreground",
		allowed_tools: ["Read"],
	}, execution());

	assert.equal(background.success, true);
	assert.equal(background.modelOutput, "Subagent started in background\nChild session: child-bg");
	assert.equal(foreground.success, true);
	assert.ok(foreground.modelOutput.length <= SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS);
	assert.deepEqual(calls, [
		{ profileId: "explore", prompt: "Inspect.", mode: "background" },
		{ profileId: "review", prompt: "Review.", mode: "foreground", allowedTools: ["Read"] },
	]);
});

test("SubagentOutput returns pending state and bounded completed output", async () => {
	let completed = false;
	const tool = new SubagentOutputTool({
		control: controlFixture({
			output: () => completed
				? {
					found: true,
					childSessionId: "child-1",
					taskId: "task-1",
					status: "completed",
					progressSequence: 2,
					report: "r".repeat(SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS * 2),
					outputReference: "subagent-task:task-1",
				}
				: {
					found: true,
					childSessionId: "child-1",
					taskId: "task-1",
					status: "running",
					progressSequence: 1,
					progressSummary: "Reading",
				},
		}),
	});

	const pending = await tool.execute({ child_session_id: "child-1" }, execution());
	completed = true;
	const done = await tool.execute({ child_session_id: "child-1" }, execution());

	assert.equal(pending.success, true);
	assert.match(pending.modelOutput, /Status: running/u);
	assert.match(pending.modelOutput, /Progress: Reading/u);
	assert.equal(done.success, true);
	assert.ok(done.modelOutput.length <= SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS);
});

test("SendMessage reports accepted and unavailable delivery", async () => {
	let accepted = true;
	const messages: string[] = [];
	const tool = new SendMessageTool({
		control: controlFixture({
			send: async (childSessionId, message) => {
				messages.push(`${childSessionId}:${message}`);
				return {
					accepted,
					childSessionId,
					delivery: accepted ? "accepted" : "unavailable",
				};
			},
		}),
	});

	const first = await tool.execute({ child_session_id: "child-1", message: "Continue" }, execution());
	accepted = false;
	const second = await tool.execute({ child_session_id: "child-1", message: "Again" }, execution());

	assert.equal(first.success, true);
	assert.equal(first.modelOutput, "Message accepted by child session child-1");
	assert.equal(second.success, false);
	assert.equal(second.errorKind, "subagent_message_unavailable");
	assert.deepEqual(messages, ["child-1:Continue", "child-1:Again"]);
});

test("subagent management lists and inspects profiles without a runtime factory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-subagent-management-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = await SubagentProfileRegistry.discover({
		homeDir: join(root, "home"),
		workspaceRoot: join(root, "workspace"),
	});
	const service = new SubagentManagementService({ registry });

	const listed = service.list();
	const inspected = service.inspect("explore");

	assert.equal(listed.ok, true);
	assert.equal(listed.profiles.length, 3);
	assert.equal(inspected.ok, true);
	assert.equal(inspected.profile?.id, "explore");
	assert.deepEqual(inspected.profile?.allowedTools, ["Read"]);
});

function controlFixture(overrides: Partial<SubagentControlContract> = {}): SubagentControlContract {
	return {
		start: overrides.start ?? (async () => ({
			status: "running",
			taskId: "task-1",
			childSessionId: "child-1",
			summary: "Subagent started in background",
		})),
		output: overrides.output ?? (() => ({
			found: false,
			childSessionId: "missing",
			status: "missing",
			progressSequence: 0,
		})),
		send: overrides.send ?? (async (childSessionId) => ({
			accepted: false,
			childSessionId,
			delivery: "unavailable",
		})),
	};
}

function execution() {
	return {
		signal: new AbortController().signal,
		ownerSessionId: "parent-session",
		callId: "call-1",
		publishLifecycle: () => undefined,
	};
}

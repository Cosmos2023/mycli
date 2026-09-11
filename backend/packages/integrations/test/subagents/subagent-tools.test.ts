import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentPath } from "@mycli/core";
import type { SubagentTaskRecord } from "@mycli/storage";
import * as integrations from "../../src/index.ts";
import {
	SEND_AGENT_MESSAGE_TOOL_DEFINITION,
	SendAgentMessageTool,
	FOLLOWUP_TASK_TOOL_DEFINITION,
	INTERRUPT_AGENT_TOOL_DEFINITION,
	InterruptAgentTool,
	LIST_AGENTS_TOOL_DEFINITION,
	ListAgentsTool,
	SPAWN_AGENT_TOOL_DEFINITION,
	SpawnAgentTool,
	serializeSubagentTaskNotification,
	SUBAGENT_NOTIFICATION_MAX_BYTES,
	SUBAGENT_NOTIFICATION_RESULT_MAX_CHARS,
	WAIT_AGENT_DEFAULT_TIMEOUT_MS,
	WAIT_AGENT_TOOL_DEFINITION,
	WaitAgentTool,
	type WaitAgentActivityContract,
	type AgentCoordinationControlContract,
} from "../../src/index.ts";

test("terminal task notifications are bounded escaped and omit non-terminal records", () => {
	const record: SubagentTaskRecord = Object.freeze({
		taskId: "task<&>",
		parentSessionId: "parent-session",
		parentTurnId: "turn-1",
		childSessionId: "child-1",
		profileId: "subagent",
		status: "completed",
		progressSequence: 1,
		payload: Object.freeze({
			report: `<done> & ${"x".repeat(SUBAGENT_NOTIFICATION_RESULT_MAX_CHARS * 2)}`,
			outputReference: "subagent-task:task-1",
		}),
		createdAt: "2026-08-07T00:00:00.000Z",
		updatedAt: "2026-08-07T00:00:01.000Z",
		completedAt: "2026-08-07T00:00:01.000Z",
	});
	const notification = serializeSubagentTaskNotification(record, {
		outputFile: "/home/user/.mycli/sessions/parent/tasks/child-1/output.txt",
	});

	assert.ok(notification);
	assert.match(notification, /<task-id>task&lt;&amp;&gt;<\/task-id>/u);
	assert.match(notification, /<agent>subagent<\/agent>/u);
	assert.match(notification, /<output-file>\/home\/user\/\.mycli\/sessions\/parent\/tasks\/child-1\/output\.txt<\/output-file>/u);
	assert.equal(notification.includes("<done>"), false);
	assert.ok(notification.length < SUBAGENT_NOTIFICATION_RESULT_MAX_CHARS + 1_000);
	const expansionHeavy = serializeSubagentTaskNotification({
		...record,
		payload: Object.freeze({ report: "\"中&".repeat(SUBAGENT_NOTIFICATION_RESULT_MAX_CHARS) }),
	});
	assert.ok(expansionHeavy);
	assert.ok(Buffer.byteLength(expansionHeavy, "utf8") <= SUBAGENT_NOTIFICATION_MAX_BYTES);
	assert.match(expansionHeavy, /<result>.*<\/result>/su);
	assert.match(expansionHeavy, /<\/task-notification>$/u);
	const longOutputFile = serializeSubagentTaskNotification(record, {
		outputFile: `/${"&".repeat(SUBAGENT_NOTIFICATION_MAX_BYTES)}`,
	});
	assert.ok(longOutputFile);
	assert.ok(Buffer.byteLength(longOutputFile, "utf8") <= SUBAGENT_NOTIFICATION_MAX_BYTES);
	assert.equal(serializeSubagentTaskNotification({
		...record,
		status: "running",
	}), undefined);
});

test("spawn_agent is the only exported child-spawn tool", () => {
	assert.equal("TASK_TOOL_DEFINITION" in integrations, false);
	assert.equal("TaskTool" in integrations, false);
	assert.equal(SPAWN_AGENT_TOOL_DEFINITION.name, "spawn_agent");
	assert.deepEqual(SPAWN_AGENT_TOOL_DEFINITION.inputSchema.required, ["task_name", "message"]);
	assert.deepEqual(WAIT_AGENT_TOOL_DEFINITION.inputSchema.required, []);
});

test("Codex-style coordination definitions use closed validated schemas", () => {
	assert.deepEqual([
		SPAWN_AGENT_TOOL_DEFINITION.name,
		SEND_AGENT_MESSAGE_TOOL_DEFINITION.name,
		FOLLOWUP_TASK_TOOL_DEFINITION.name,
		INTERRUPT_AGENT_TOOL_DEFINITION.name,
		LIST_AGENTS_TOOL_DEFINITION.name,
	], ["spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents"]);
	assert.deepEqual(SPAWN_AGENT_TOOL_DEFINITION.inputSchema.required, ["task_name", "message"]);
	assert.deepEqual(SEND_AGENT_MESSAGE_TOOL_DEFINITION.inputSchema.required, ["target", "message"]);
	assert.deepEqual(FOLLOWUP_TASK_TOOL_DEFINITION.inputSchema.required, ["target", "message"]);
	assert.deepEqual(INTERRUPT_AGENT_TOOL_DEFINITION.inputSchema.required, ["target"]);
	assert.deepEqual(LIST_AGENTS_TOOL_DEFINITION.inputSchema.required, []);
	for (const definition of [
		SPAWN_AGENT_TOOL_DEFINITION,
		SEND_AGENT_MESSAGE_TOOL_DEFINITION,
		FOLLOWUP_TASK_TOOL_DEFINITION,
		INTERRUPT_AGENT_TOOL_DEFINITION,
		LIST_AGENTS_TOOL_DEFINITION,
		WAIT_AGENT_TOOL_DEFINITION,
	]) {
		assert.equal(definition.inputSchema.additionalProperties, false);
		assert.match(definition.description, /\S/u);
		assertDescribedProperties(definition.inputSchema, definition.name);
	}
});

test("coordination definitions require the parent to wait for and integrate child reports", () => {
	assert.match(SPAWN_AGENT_TOOL_DEFINITION.description, /terminal report is delivered automatically/u);
	assert.match(SPAWN_AGENT_TOOL_DEFINITION.description, /call wait_agent/u);
	assert.match(SEND_AGENT_MESSAGE_TOOL_DEFINITION.description, /does not replace waiting/u);
	assert.match(FOLLOWUP_TASK_TOOL_DEFINITION.description, /integrate the subsequent report/u);
	assert.match(LIST_AGENTS_TOOL_DEFINITION.description, /after compaction or resume/u);
	assert.match(WAIT_AGENT_TOOL_DEFINITION.description, /next model step/u);
	assert.match(WAIT_AGENT_TOOL_DEFINITION.description, /timeout is not completion/u);
	assert.match(WAIT_AGENT_TOOL_DEFINITION.description, /before relevant reports are integrated/u);
});

test("Codex-style coordination adapters return typed stable results", async () => {
	const calls: Array<Readonly<Record<string, unknown>>> = [];
	const control: AgentCoordinationControlContract = {
		spawnAgent: async (input) => {
			calls.push({ kind: "spawn", ...input });
			return {
				status: "running",
				taskId: "task-1",
				childSessionId: "child-1",
				taskName: input.taskName,
				agentPath: parseAgentPath(`/root/${input.taskName}`),
				summary: "Subagent started in background",
			};
		},
		sendAgent: async (input) => {
			calls.push({ kind: "send", ...input });
			return {
				status: "queued",
				messageId: `message-${input.triggerMode}`,
				receiverThreadId: "child-1",
				receiverPath: parseAgentPath("/root/tests"),
				receiverSequence: input.triggerMode === "queue_only" ? 1 : 2,
				triggerMode: input.triggerMode,
				projected: true,
			};
		},
		interruptAgent: async (input) => {
			calls.push({ kind: "interrupt", ...input });
			return { interrupted: true, threadId: "child-1", path: parseAgentPath("/root/tests") };
		},
		listAgents: (input) => {
			calls.push({ kind: "list", ...input });
			return [{
				threadId: "child-1",
				path: parseAgentPath("/root/tests"),
				taskName: "tests",
				status: "idle",
				resident: true,
			}];
		},
	};
	const spawn = new SpawnAgentTool({ control });
	const send = new SendAgentMessageTool({
		control,
		definition: SEND_AGENT_MESSAGE_TOOL_DEFINITION,
		triggerMode: "queue_only",
	});
	const follow = new SendAgentMessageTool({
		control,
		definition: FOLLOWUP_TASK_TOOL_DEFINITION,
		triggerMode: "follow_up",
	});
	const interrupt = new InterruptAgentTool({ control });
	const list = new ListAgentsTool({ control });

	const spawned = await spawn.execute({
		task_name: "tests",
		message: "write tests",
		fork_turns: "3",
	}, execution({ ownerTurnId: "turn-1" }));
	const sent = await send.execute({ target: "/root/tests", message: "status" }, execution());
	const followed = await follow.execute({ target: "tests", message: "continue" }, execution());
	const interrupted = await interrupt.execute({ target: "tests", reason: "stop" }, execution());
	const listed = await list.execute({ path_prefix: "/root/tests" }, execution());

	assert.equal(spawned.success, true);
	assert.deepEqual(JSON.parse(spawned.modelOutput), {
		status: "running",
		thread_id: "child-1",
		task_name: "tests",
		agent_path: "/root/tests",
	});
	assert.equal(JSON.parse(sent.modelOutput).trigger_mode, "queue_only");
	assert.equal(JSON.parse(followed.modelOutput).trigger_mode, "follow_up");
	assert.equal(JSON.parse(interrupted.modelOutput).interrupted, true);
	assert.equal(JSON.parse(listed.modelOutput).agents[0].status, "idle");
	assert.equal(calls.length, 5);
	assert.deepEqual(calls[0], {
		kind: "spawn",
		ownerSessionId: "parent-session",
		ownerTurnId: "turn-1",
		taskName: "tests",
		message: "write tests",
		forkTurns: "3",
	});
});

test("wait_agent delegates owner activity and maps activity timeout and unavailable outcomes", async () => {
	const calls: unknown[] = [];
	let outcome: Awaited<ReturnType<WaitAgentActivityContract["wait"]>> = {
		kind: "activity",
		activity: "task_notification",
		pendingCount: 1,
	};
	const tool = new WaitAgentTool({
		activity: {
			wait: async (input) => {
				calls.push(input);
				return outcome;
			},
		},
	});

	const activity = await tool.execute({}, execution({ ownerTurnId: "turn-1" }));
	outcome = { kind: "timeout" };
	const timeout = await tool.execute(
		{ timeout_ms: 500 },
		execution({ ownerTurnId: "turn-1" }),
	);
	outcome = { kind: "unavailable" };
	const unavailable = await tool.execute({}, execution({ ownerTurnId: "turn-1" }));
	const missingTurn = await tool.execute({}, execution());

	assert.equal(activity.success, true);
	assert.match(activity.modelOutput, /task_notification/u);
	assert.equal(timeout.success, true);
	assert.equal(timeout.summary, "Agent wait timed out");
	assert.equal(unavailable.success, false);
	assert.equal(unavailable.errorKind, "agent_wait_unavailable");
	assert.equal(missingTurn.errorKind, "agent_wait_unavailable");
	assert.deepEqual(calls.map((call) => (
		call as { timeoutMs: number }
	).timeoutMs), [WAIT_AGENT_DEFAULT_TIMEOUT_MS, 500, WAIT_AGENT_DEFAULT_TIMEOUT_MS]);
	assert.deepEqual(calls.map((call) => (
		call as { parentSessionId: string; parentTurnId: string }
	).parentSessionId), ["parent-session", "parent-session", "parent-session"]);
	assert.deepEqual(calls.map((call) => (
		call as { parentSessionId: string; parentTurnId: string }
	).parentTurnId), ["turn-1", "turn-1", "turn-1"]);
});

function execution(overrides: { readonly ownerTurnId?: string } = {}) {
	return {
		signal: new AbortController().signal,
		ownerSessionId: "parent-session",
		callId: "call-1",
		publishLifecycle: () => undefined,
		...overrides,
	};
}

function assertDescribedProperties(
	schema: Readonly<Record<string, unknown>>,
	path: string,
): void {
	const properties = schema.properties;
	assert.equal(typeof properties, "object", `${path}.properties must be an object`);
	assert.notEqual(properties, null, `${path}.properties must be an object`);
	assert.equal(Array.isArray(properties), false, `${path}.properties must be an object`);
	for (const [name, value] of Object.entries(properties as Readonly<Record<string, unknown>>)) {
		assert.equal(typeof value, "object", `${path}.${name} must be an object`);
		assert.notEqual(value, null, `${path}.${name} must be an object`);
		const property = value as Readonly<Record<string, unknown>>;
		assert.equal(typeof property.description, "string", `${path}.${name} must have a description`);
		assert.match(property.description as string, /\S/u);
	}
}

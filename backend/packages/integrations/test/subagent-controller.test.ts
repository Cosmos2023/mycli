import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { rootAgentPath } from "@mycli/core";
import { SQLiteSessionStore } from "@mycli/storage";
import { AgentSupervisor } from "@mycli/runtime";
import {
	SubagentController,
	type ChildRuntimeCreateInput,
	type ChildRuntimeEvent,
	type ChildRuntimeFactory,
	type ChildRuntimeHandle,
	type ChildRuntimeResult,
	type ResolvedSubagentSpawnContext,
	type ResolveSubagentSpawnContextInput,
} from "../src/index.ts";

test("subagent controller runs a foreground child with frozen tools and durable progress", async (t) => {
	const fixture = await controllerFixture(t);
	const creates: ChildRuntimeCreateInput[] = [];
	let closed = 0;
	const factory: ChildRuntimeFactory = {
		create: async (input) => {
			creates.push(input);
			return handle({
				run: async (_prompt, _signal, emit) => {
					emit({ type: "progress", summary: "Inspecting files" });
					emit({ type: "usage", usage: { input_tokens: 12 } });
					return completed("Grounded report", { input_tokens: 12, output_tokens: 4 });
				},
				close: async () => { closed += 1; },
			});
		},
	};
	const controller = fixture.controller(factory, {
		createTaskId: () => "task-foreground",
		createChildSessionId: () => "child-foreground",
	});

	const result = await controller.start({
		prompt: "Inspect and update the target.",
		mode: "foreground",
	});

	assert.equal(result.status, "completed");
	assert.equal(result.report, "Grounded report");
	assert.equal(creates.length, 1);
	assert.deepEqual({
		parentSessionId: creates[0]?.parentSessionId,
		parentTurnId: creates[0]?.parentTurnId,
		childSessionId: creates[0]?.childSessionId,
		tools: creates[0]?.tools,
	}, {
		parentSessionId: "parent-session",
		parentTurnId: "parent-turn",
		childSessionId: "child-foreground",
		tools: ["Read", "Edit", "Patch", "Write", "Shell"],
	});
	assert.ok(Object.isFrozen(creates[0]));
	assert.ok(Object.isFrozen(creates[0]?.tools));
	assert.ok(Object.isFrozen(creates[0]?.config));
	assert.deepEqual(fixture.store.subagentTasks.get("task-foreground"), {
		taskId: "task-foreground",
		parentSessionId: "parent-session",
		parentTurnId: "parent-turn",
		childSessionId: "child-foreground",
		profileId: "subagent",
		status: "completed",
		progressSequence: 1,
		payload: {
			mode: "foreground",
			description: "Inspect and update the target.",
			progressSummary: "Inspecting files",
			report: "Grounded report",
			outputReference: "subagent-task:task-foreground",
			usage: { input_tokens: 12, output_tokens: 4 },
		},
		createdAt: NOW,
		updatedAt: NOW,
		completedAt: NOW,
	});
	assert.equal(closed, 0);
	assert.equal(await controller.unload("child-foreground"), true);
	assert.equal(closed, 1);
});

test("spawn_agent preserves the explicit task name and fork mode", async (t) => {
	const fixture = await controllerFixture(t);
	const creates: ChildRuntimeCreateInput[] = [];
	const resultDeferred = deferred<ChildRuntimeResult>();
	const controller = fixture.controller({
		create: async (input) => {
			creates.push(input);
			return handle({ run: async () => resultDeferred.promise });
		},
	}, {
		createTaskId: () => "task-spawn-agent",
		createChildSessionId: () => "child-spawn-agent",
	});

	const result = await controller.spawnAgent({
		ownerSessionId: "parent-session",
		ownerTurnId: "parent-turn",
		taskName: "test-writer",
		message: "Write focused tests.",
		forkTurns: "3",
	});

	assert.equal(result.status, "running");
	assert.equal(result.taskName, "test-writer");
	assert.equal(result.agentPath, "/root/test-writer");
	assert.deepEqual(creates[0]?.config.forkTurns, { kind: "last_n", turns: 3 });
	resultDeferred.resolve(completed("done"));
	await controller.waitFor("child-spawn-agent");
	await controller.close();
});

test("subagent controller returns background work immediately and supports output and messaging", async (t) => {
	const fixture = await controllerFixture(t);
	const resultDeferred = deferred<ChildRuntimeResult>();
	const messages: string[] = [];
	const controller = fixture.controller({
		create: async () => handle({
			run: async () => resultDeferred.promise,
			send: async (message) => { messages.push(message); },
		}),
	}, {
		createTaskId: () => "task-background",
		createChildSessionId: () => "child-background",
	});

	const started = await controller.start({
		prompt: "Inspect the repository.",
		mode: "background",
	});

	assert.deepEqual(started, {
		status: "running",
		taskId: "task-background",
		childSessionId: "child-background",
		summary: "Subagent started in background",
	});
	assert.equal(controller.output("child-background").status, "running");
	assert.deepEqual(await controller.send("child-background", "Also inspect tests."), {
		accepted: true,
		childSessionId: "child-background",
		delivery: "accepted",
	});
	assert.deepEqual(messages, ["Also inspect tests."]);

	resultDeferred.resolve(completed("Background report", { output_tokens: 3 }));
	await controller.waitFor("child-background");
	assert.deepEqual(controller.output("child-background"), {
		found: true,
		childSessionId: "child-background",
		taskId: "task-background",
		status: "completed",
		progressSequence: 0,
		report: "Background report",
		outputReference: "subagent-task:task-background",
	});
	assert.deepEqual(fixture.store.subagentTasks.get("task-background")?.payload, {
		mode: "background",
		description: "Inspect the repository.",
		report: "Background report",
		outputReference: "subagent-task:task-background",
		usage: { output_tokens: 3 },
	});
	assert.deepEqual(await controller.send("child-background", "Too late"), {
		accepted: false,
		childSessionId: "child-background",
		delivery: "unavailable",
	});
});

test("subagent controller binds each child to the executing parent session", async (t) => {
	const fixture = await controllerFixture(t);
	const creates: ChildRuntimeCreateInput[] = [];
	const resultDeferred = deferred<ChildRuntimeResult>();
	const messages: string[] = [];
	const controller = fixture.controller({
		create: async (input) => {
			creates.push(input);
			return handle({
				run: async () => resultDeferred.promise,
				send: async (message) => { messages.push(message); },
			});
		},
	}, {
		createTaskId: () => "task-resumed",
		createChildSessionId: () => "child-resumed",
	});

	await controller.start({
		prompt: "Inspect resumed session.",
		mode: "background",
		parentSessionId: "resumed-session",
		parentTurnId: "resumed-turn",
	});

	assert.equal(fixture.store.subagentTasks.list("parent-session").length, 0);
	assert.equal(fixture.store.subagentTasks.list("resumed-session").length, 1);
	assert.equal(creates[0]?.parentSessionId, "resumed-session");
	assert.equal(controller.output("child-resumed").status, "missing");
	assert.equal(controller.output("child-resumed", "resumed-session").status, "running");
	assert.equal((await controller.send(
		"child-resumed",
		"Inspect tests too.",
		"parent-session",
	)).accepted, false);
	assert.equal((await controller.send(
		"child-resumed",
		"Inspect tests too.",
		"resumed-session",
	)).accepted, true);
	assert.deepEqual(messages, ["Inspect tests too."]);

	resultDeferred.resolve(completed("Resumed report"));
	await controller.waitFor("child-resumed");
	assert.equal(controller.output("child-resumed", "resumed-session").status, "completed");
});

test("subagent controller contains child failures and recovers abandoned running tasks", async (t) => {
	const fixture = await controllerFixture(t);
	let closed = 0;
	const controller = fixture.controller({
		create: async () => handle({
			run: async () => { throw new Error("private provider response"); },
			close: async () => { closed += 1; },
		}),
	}, {
		createTaskId: () => "task-failed",
		createChildSessionId: () => "child-failed",
	});

	const failed = await controller.start({
		prompt: "Review the changes.",
		mode: "foreground",
	});

	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "child runtime failed");
	assert.equal(JSON.stringify(failed).includes("private provider"), false);
	assert.equal(closed, 1);

	fixture.store.subagentTasks.reserve({
		taskId: "task-abandoned",
		parentSessionId: "parent-session",
		parentTurnId: "old-turn",
		childSessionId: "child-abandoned",
		profileId: "subagent",
	});
	fixture.store.subagentTasks.markRunning({
		taskId: "task-abandoned",
		parentSessionId: "parent-session",
		childSessionId: "child-abandoned",
	});
	assert.equal(controller.recoverAbandoned("restart"), 1);
	assert.equal(fixture.store.subagentTasks.get("task-abandoned")?.status, "interrupted");
});

test("subagent controller interrupts and bounds shutdown for an unresponsive child", async (t) => {
	const fixture = await controllerFixture(t);
	const calls: string[] = [];
	const controller = fixture.controller({
		create: async () => handle({
			run: async () => new Promise<ChildRuntimeResult>(() => undefined),
			interrupt: async (reason) => { calls.push(`interrupt:${reason}`); },
			close: async () => { calls.push("close"); },
		}),
	}, {
		createTaskId: () => "task-hung",
		createChildSessionId: () => "child-hung",
		shutdownTimeoutMs: 20,
	});
	await controller.start({
		prompt: "Wait forever.",
		mode: "background",
	});

	await controller.close();
	await controller.close();

	assert.deepEqual(calls, ["interrupt:parent shutdown", "close"]);
	assert.equal(fixture.store.subagentTasks.get("task-hung")?.status, "interrupted");
});

test("subagent controller inherits parent tools without profile budgets or model overrides", async (t) => {
	const fixture = await controllerFixture(t);
	const creates: ChildRuntimeCreateInput[] = [];
	const controller = fixture.controller({
		create: async (input) => {
			creates.push(input);
			return handle();
		},
	}, {
		createTaskId: () => "task-inherit",
		createChildSessionId: () => "child-inherit",
	});

	await controller.start({
		prompt: "Run.",
		mode: "foreground",
	});

	assert.equal(creates[0]?.budget, undefined);
	assert.equal(creates[0]?.model, undefined);
	assert.deepEqual(creates[0]?.tools, ["Read", "Edit", "Patch", "Write", "Shell"]);
});

test("subagent controller freezes coordination tools from configured depth", async (t) => {
	const fixture = await controllerFixture(t);
	const creates: ChildRuntimeCreateInput[] = [];
	const factory: ChildRuntimeFactory = {
		create: async (input) => {
			creates.push(input);
			return handle();
		},
	};
	const parentTools = () => [
		"Read",
		"spawn_agent",
		"send_message",
		"followup_task",
		"interrupt_agent",
		"list_agents",
		"wait_agent",
	];
	const shallow = fixture.controller(factory, {
		parentTools,
		maxAgentDepth: 1,
		createTaskId: () => "depth-task-1",
		createChildSessionId: () => "depth-child-1",
	});
	await shallow.start({ prompt: "Run.", mode: "foreground" });
	const nested = fixture.controller(factory, {
		parentTools,
		maxAgentDepth: 2,
		createTaskId: () => "depth-task-2",
		createChildSessionId: () => "depth-child-2",
			createSupervisor: (options) => new AgentSupervisor({
				spawnStore: fixture.store.agentSpawns,
				threadStore: fixture.store.agentThreads,
			taskStore: fixture.store.subagentTasks,
			runtimeFactory: factory,
			maxDepth: 2,
			...options,
		}),
	});
	await nested.start({ prompt: "Run.", mode: "foreground" });

	assert.deepEqual(creates[0]?.tools, ["Read"]);
	assert.deepEqual(creates[1]?.tools, parentTools());
	await Promise.all([shallow.close(), nested.close()]);
});

const NOW = "2026-08-06T00:00:00.000Z";

async function controllerFixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-subagent-controller-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SQLiteSessionStore({ dbPath: join(root, "sessions.db"), clock: () => NOW });
	t.after(() => store.close());
	return {
		store,
		controller: (
			factory: ChildRuntimeFactory,
			overrides: Partial<ConstructorParameters<typeof SubagentController>[0]> = {},
		) => new SubagentController({
				createSupervisor: (supervisorOptions) => new AgentSupervisor({
					spawnStore: store.agentSpawns,
					threadStore: store.agentThreads,
				taskStore: store.subagentTasks,
				runtimeFactory: factory,
				...supervisorOptions,
			}),
			parentSessionId: "parent-session",
			parentTurnId: () => "parent-turn",
			parentTools: () => ["Read", "Edit", "Patch", "Write", "Shell"],
			resolveSpawnContext: testSubagentSpawnContext,
			createTaskId: () => "task-1",
			createChildSessionId: () => "child-1",
			...overrides,
		}),
	};
}

function testSubagentSpawnContext(
	input: ResolveSubagentSpawnContextInput,
): ResolvedSubagentSpawnContext {
	return Object.freeze({
		parentThreadId: input.parentSessionId,
		rootThreadId: input.parentSessionId,
		parentPath: rootAgentPath(),
		config: Object.freeze({
			workspaceRoot: ".",
			cwd: ".",
			environment: Object.freeze({}),
			executionPolicy: Object.freeze({
				trusted: false,
				permission: "read-only" as const,
				sandboxMode: "read-only" as const,
				filesystem: "read_only" as const,
				network: "disabled" as const,
				writableRoots: Object.freeze([]),
			}),
			provider: Object.freeze({
				provider: "openai" as const,
				protocol: "responses" as const,
				model: "inherit",
			}),
			instructions: Object.freeze({ project: "Test system instructions." }),
			tools: Object.freeze([...input.tools]),
			forkTurns: "none" as const,
		}),
	});
}

function handle(overrides: Partial<ChildRuntimeHandle> = {}): ChildRuntimeHandle {
	return {
		run: overrides.run ?? (async () => completed("done")),
		send: overrides.send ?? (async () => undefined),
		interrupt: overrides.interrupt ?? (async () => undefined),
		close: overrides.close ?? (async () => undefined),
	};
}

function completed(
	report: string,
	usage: Readonly<Record<string, number>> = {},
): ChildRuntimeResult {
	return { status: "completed", report, usage };
}

function deferred<Value>() {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => { resolve = settle; });
	return { promise, resolve };
}

void ({} as ChildRuntimeEvent);

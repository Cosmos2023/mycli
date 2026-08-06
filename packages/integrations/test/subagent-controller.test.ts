import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SQLiteSessionStore } from "@mycli/storage";
import {
	SubagentController,
	SubagentProfileRegistry,
	type ChildRuntimeCreateInput,
	type ChildRuntimeEvent,
	type ChildRuntimeFactory,
	type ChildRuntimeHandle,
	type ChildRuntimeResult,
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
		profileId: "executor",
		prompt: "Inspect and update the target.",
		mode: "foreground",
	});

	assert.equal(result.status, "completed");
	assert.equal(result.report, "Grounded report");
	assert.deepEqual(creates, [{
		parentSessionId: "parent-session",
		parentTurnId: "parent-turn",
		childSessionId: "child-foreground",
		profileId: "executor",
		tools: ["Read", "Edit", "Patch", "Write"],
	}]);
	assert.ok(Object.isFrozen(creates[0]));
	assert.ok(Object.isFrozen(creates[0]?.tools));
	assert.deepEqual(fixture.store.subagentTasks.get("task-foreground"), {
		taskId: "task-foreground",
		parentSessionId: "parent-session",
		parentTurnId: "parent-turn",
		childSessionId: "child-foreground",
		profileId: "executor",
		status: "completed",
		progressSequence: 1,
		payload: {
			progressSummary: "Inspecting files",
			report: "Grounded report",
			outputReference: "subagent-task:task-foreground",
			usage: { input_tokens: 12, output_tokens: 4 },
		},
		createdAt: NOW,
		updatedAt: NOW,
		completedAt: NOW,
	});
	assert.equal(closed, 1);
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
		profileId: "explore",
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
	assert.deepEqual(await controller.send("child-background", "Too late"), {
		accepted: false,
		childSessionId: "child-background",
		delivery: "unavailable",
	});
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
		profileId: "review",
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
		profileId: "explore",
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
		profileId: "explore",
		prompt: "Wait forever.",
		mode: "background",
	});

	await controller.close();
	await controller.close();

	assert.deepEqual(calls, ["interrupt:parent shutdown", "close"]);
	assert.equal(fixture.store.subagentTasks.get("task-hung")?.status, "interrupted");
});

test("subagent controller forwards optional budgets without inventing defaults", async (t) => {
	const fixture = await controllerFixture(t);
	const profiles = join(fixture.workspaceRoot, ".mycli", "subagents");
	await mkdir(profiles, { recursive: true });
	await writeFile(join(profiles, "unlimited.toml"), [
		'id = "unlimited"',
		'instruction = "Run without implicit limits."',
		'allowed_tools = ["Read"]',
	].join("\n"), "utf8");
	await writeFile(join(profiles, "limited.toml"), [
		'id = "limited"',
		'instruction = "Run with explicit limits."',
		'allowed_tools = ["Read"]',
		'model = "gpt-child"',
		'[budget]',
		'max_turns = 3',
		'max_tool_calls = 4',
	].join("\n"), "utf8");
	const registry = await SubagentProfileRegistry.discover({
		homeDir: fixture.homeDir,
		workspaceRoot: fixture.workspaceRoot,
	});
	const creates: ChildRuntimeCreateInput[] = [];
	let taskIndex = 0;
	const controller = fixture.controller({
		create: async (input) => {
			creates.push(input);
			return handle({
				run: async () => completed(JSON.stringify({
					providerSteps: input.budget?.maxTurns ?? 12,
					toolCalls: input.budget?.maxToolCalls ?? 20,
				})),
			});
		},
	}, {
		registry,
		createTaskId: () => `task-budget-${++taskIndex}`,
		createChildSessionId: () => `child-budget-${taskIndex}`,
	});

	const unlimited = await controller.start({
		profileId: "unlimited",
		prompt: "Run.",
		mode: "foreground",
	});
	const limited = await controller.start({
		profileId: "limited",
		prompt: "Run.",
		mode: "foreground",
	});

	assert.deepEqual(JSON.parse(unlimited.report ?? "{}"), { providerSteps: 12, toolCalls: 20 });
	assert.deepEqual(JSON.parse(limited.report ?? "{}"), { providerSteps: 3, toolCalls: 4 });
	assert.equal(creates[0]?.budget, undefined);
	assert.deepEqual(creates[1]?.budget, { maxTurns: 3, maxToolCalls: 4 });
	assert.equal(creates[1]?.model, "gpt-child");
});

const NOW = "2026-08-06T00:00:00.000Z";

async function controllerFixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-subagent-controller-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const store = new SQLiteSessionStore({ dbPath: join(root, "sessions.db"), clock: () => NOW });
	t.after(() => store.close());
	const registry = await SubagentProfileRegistry.discover({ homeDir, workspaceRoot });
	return {
		homeDir,
		workspaceRoot,
		store,
		controller: (
			factory: ChildRuntimeFactory,
			overrides: Partial<ConstructorParameters<typeof SubagentController>[0]> = {},
		) => new SubagentController({
			registry,
			taskStore: store.subagentTasks,
			factory,
			parentSessionId: "parent-session",
			parentTurnId: () => "parent-turn",
			parentTools: () => ["Read", "Edit", "Patch", "Write", "Shell"],
			createTaskId: () => "task-1",
			createChildSessionId: () => "child-1",
			...overrides,
		}),
	};
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

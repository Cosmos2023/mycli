import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseAgentPath,
	rootAgentPath,
	type AgentCanonicalEvent,
	type AgentSpawnConfigSnapshot,
} from "@mycli/core";
import { SQLiteSessionStore } from "@mycli/storage";
import {
	AgentSupervisor,
	type AgentThreadRuntimeHandle,
	type AgentThreadRuntimeResult,
} from "../src/index.ts";

const NOW = "2026-08-08T00:00:00.000Z";

test("supervises a foreground agent into durable idle state", async (t) => {
	const fixture = await supervisorFixture(t);
	const events: AgentCanonicalEvent[] = [];
	const terminalOrder: string[] = [];
	let closed = 0;
	const supervisor = fixture.supervisor(handle({
		run: async (_prompt, _signal, emit) => {
			emit({ type: "progress", summary: "Inspecting files" });
			return { status: "completed", report: "Grounded report", usage: { output_tokens: 4 } };
		},
		close: async () => { closed += 1; },
	}), {
		onEvent: (event) => {
			events.push(event);
			if (event.kind === "completed" && event.type === "agent_lifecycle") {
				terminalOrder.push(`delivery:${event.task?.taskStatus}:${event.threadStatus}`);
				terminalOrder.push("event:completed");
			}
		},
	});

	const result = await supervisor.spawn(spawnInput({ mode: "foreground" }));

	assert.equal(result.status, "completed");
	assert.equal(result.report, "Grounded report");
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "idle");
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "completed");
	assert.equal(closed, 0);
	assert.deepEqual(events.map((event) => event.kind), [
		"reserved",
		"spawned",
		"started",
		"progress",
		"completed",
	]);
	assert.deepEqual(terminalOrder, [
		"delivery:completed:idle",
		"event:completed",
	]);

	assert.equal(await supervisor.unload("child-1"), true);
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "unloaded");
	assert.equal(closed, 1);
});

test("keeps a waiting child non-terminal and resumes the same resident runtime", async (t) => {
	const fixture = await supervisorFixture(t);
	const resume = deferred<void>();
	const events: AgentCanonicalEvent[] = [];
	const supervisor = fixture.supervisor(handle({
		run: async (_prompt, _signal, emit) => {
			emit({ type: "waiting", reason: "approval", summary: "Waiting for Shell approval" });
			await resume.promise;
			emit({ type: "resumed", summary: "Approval resolved" });
			return { status: "completed", report: "Approved report", usage: {} };
		},
	}), {
		onEvent: (event) => { events.push(event); },
	});

	const started = await supervisor.spawn(spawnInput({ mode: "background" }));
	assert.equal(started.status, "running");
	await waitFor(() => fixture.store.agentThreads.get("child-1")?.status === "waiting");
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "running");
	assert.equal(events.some((event) => ["completed", "failed", "interrupted"].includes(event.kind)), false);

	resume.resolve();
	await supervisor.waitFor("child-1");
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "idle");
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "completed");
	assert.deepEqual(events.map((event) => event.kind), [
		"reserved",
		"spawned",
		"started",
		"waiting",
		"resumed",
		"completed",
	]);
});

test("starts one mailbox follow-up turn for an idle resident", async (t) => {
	const fixture = await supervisorFixture(t);
	let taskIndex = 0;
	let mailboxRuns = 0;
	const deliveries: string[] = [];
	const supervisor = fixture.supervisor(handle({
		runMailbox: async () => {
			mailboxRuns += 1;
			return { status: "completed", report: "Follow-up report", usage: {} };
		},
	}), {
		createTaskId: () => `task-${++taskIndex}`,
		onEvent: (event) => {
			if (event.kind === "completed" && "task" in event && event.task) {
				deliveries.push(event.task.taskId);
			}
		},
	});

	await supervisor.spawn(spawnInput({ mode: "foreground" }));
	assert.equal(await supervisor.followUp("child-1", "call-follow-up", "Continue review"), true);
	await supervisor.waitFor("child-1");

	assert.equal(mailboxRuns, 1);
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "idle");
	assert.deepEqual(fixture.store.subagentTasks.list("parent-session").map((task) => ({
		taskId: task.taskId,
		status: task.status,
		description: task.payload.description,
	})), [{
		taskId: "task-2",
		status: "completed",
		description: "Continue review",
	}, {
		taskId: "task-1",
		status: "completed",
		description: "Inspect the repository.",
	}]);
	assert.deepEqual(deliveries, ["task-1", "task-2"]);
});

test("reloads an unloaded agent before its mailbox follow-up", async (t) => {
	const fixture = await supervisorFixture(t);
	let taskIndex = 0;
	const purposes: Array<string | undefined> = [];
	const events: AgentCanonicalEvent[] = [];
	let mailboxRuns = 0;
	const supervisor = new AgentSupervisor({
		spawnStore: fixture.store.agentSpawns,
		threadStore: fixture.store.agentThreads,
		taskStore: fixture.store.subagentTasks,
		runtimeFactory: {
			create: async (input) => {
				purposes.push(input.purpose);
				return handle({
					runMailbox: async () => {
						mailboxRuns += 1;
						return { status: "completed", report: "Reloaded report", usage: {} };
					},
				});
			},
		},
		createTaskId: () => `reload-task-${++taskIndex}`,
		createThreadId: () => "reload-child",
		clock: () => NOW,
		onEvent: (event) => { events.push(event); },
	});

	await supervisor.spawn(spawnInput({ taskName: "reload", mode: "foreground" }));
	assert.equal(await supervisor.unload("reload-child"), true);
	assert.equal(await supervisor.followUp("reload-child", "reload-call", "Resume durable work"), true);
	await supervisor.waitFor("reload-child");

	assert.deepEqual(purposes, [undefined, "reload"]);
	assert.equal(mailboxRuns, 1);
	assert.equal(fixture.store.agentThreads.get("reload-child")?.status, "idle");
	assert.equal(fixture.store.subagentTasks.list("parent-session").length, 2);
	assert.deepEqual(events.map((event) => event.kind), [
		"reserved",
		"spawned",
		"started",
		"completed",
		"unloaded",
		"loaded",
		"started",
		"completed",
	]);
});

test("rehydrates a durable idle agent that has no process-local resident", async (t) => {
	const fixture = await supervisorFixture(t);
	const first = fixture.supervisor(handle(), {
		createTaskId: () => "restart-task-1",
		createThreadId: () => "restart-child",
	});
	await first.spawn(spawnInput({ taskName: "restart", mode: "foreground" }));

	let mailboxRuns = 0;
	let reloadConfig: AgentSpawnConfigSnapshot | undefined;
	const restarted = new AgentSupervisor({
		spawnStore: fixture.store.agentSpawns,
		threadStore: fixture.store.agentThreads,
		taskStore: fixture.store.subagentTasks,
		runtimeFactory: {
			create: async (input) => {
				reloadConfig = input.config;
				return handle({
					runMailbox: async () => {
						mailboxRuns += 1;
						return { status: "completed", report: "Restarted report", usage: {} };
					},
				});
			},
		},
		createTaskId: () => "restart-task-2",
		clock: () => NOW,
	});

	assert.equal(await restarted.followUp("restart-child", "restart-call", "Continue after restart"), true);
	await restarted.waitFor("restart-child");

	assert.equal(mailboxRuns, 1);
	assert.deepEqual(reloadConfig, spawnConfig());
	assert.equal(fixture.store.subagentTasks.get("restart-task-2")?.payload.report, "Restarted report");
	assert.equal(fixture.store.agentThreads.get("restart-child")?.status, "idle");
});

test("allows explicit follow-up only for restart-recoverable interruption", async (t) => {
	const fixture = await supervisorFixture(t);
	const first = fixture.supervisor(handle(), {
		createTaskId: () => "recoverable-task-1",
		createThreadId: () => "recoverable-child",
	});
	await first.spawn(spawnInput({ taskName: "recoverable", mode: "foreground" }));
	fixture.store.agentThreads.transition({
		threadId: "recoverable-child",
		status: "interrupted",
		terminalSummary: "agent runtime owner unavailable after restart",
	});

	let mailboxRuns = 0;
	const restarted = new AgentSupervisor({
		spawnStore: fixture.store.agentSpawns,
		threadStore: fixture.store.agentThreads,
		taskStore: fixture.store.subagentTasks,
		runtimeFactory: {
			create: async () => handle({
				runMailbox: async () => {
					mailboxRuns += 1;
					return { status: "completed", report: "Recovered report", usage: {} };
				},
			}),
		},
		createTaskId: () => "recoverable-task-2",
		clock: () => NOW,
	});

	assert.equal(await restarted.followUp(
		"recoverable-child",
		"recoverable-call",
		"Continue safely",
	), true);
	await restarted.waitFor("recoverable-child");
	assert.equal(mailboxRuns, 1);
	assert.equal(fixture.store.agentThreads.get("recoverable-child")?.status, "idle");
	assert.equal(fixture.store.subagentTasks.get("recoverable-task-2")?.payload.report, "Recovered report");

	fixture.store.agentThreads.transition({
		threadId: "recoverable-child",
		status: "interrupted",
		terminalSummary: "parent interrupted child",
	});
	const anotherRestart = new AgentSupervisor({
		spawnStore: fixture.store.agentSpawns,
		threadStore: fixture.store.agentThreads,
		taskStore: fixture.store.subagentTasks,
		runtimeFactory: { create: async () => handle() },
		clock: () => NOW,
	});
	assert.equal(await anotherRestart.followUp(
		"recoverable-child",
		"not-recoverable-call",
		"Do not restart",
	), false);
});

test("sends to and interrupts a running background agent", async (t) => {
	const fixture = await supervisorFixture(t);
	const result = deferred<AgentThreadRuntimeResult>();
	const messages: string[] = [];
	const interrupts: string[] = [];
	const terminalOrder: string[] = [];
	let observedAbort = false;
	const supervisor = fixture.supervisor(handle({
		run: async (_prompt, signal) => {
			await result.promise;
			observedAbort = signal.aborted;
			throw new Error("interrupted");
		},
		send: async (message) => { messages.push(message); },
		interrupt: async (reason) => {
			interrupts.push(reason);
			result.resolve({ status: "interrupted", report: "", usage: {} });
		},
	}), {
		onEvent: (event) => {
			if (event.kind === "interrupted" && event.type === "agent_lifecycle") {
				terminalOrder.push(`delivery:${event.task?.taskStatus}:${event.threadStatus}`);
				terminalOrder.push("event:interrupted");
			}
		},
	});

	const started = await supervisor.spawn(spawnInput({ mode: "background" }));
	assert.equal(started.status, "running");
	assert.deepEqual(await supervisor.send("child-1", "Inspect tests too", "parent-session"), {
		accepted: true,
		childSessionId: "child-1",
		delivery: "accepted",
	});
	assert.deepEqual(messages, ["Inspect tests too"]);

	assert.equal(await supervisor.interrupt("child-1", "stop now"), true);
	assert.equal(observedAbort, true);
	assert.deepEqual(interrupts, ["stop now"]);
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "interrupted");
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "interrupted");
	assert.deepEqual(terminalOrder, [
		"delivery:interrupted:interrupted",
		"event:interrupted",
	]);
	assert.equal((await supervisor.send("child-1", "too late", "parent-session")).accepted, false);
});

test("contains runtime creation failure in durable terminal state", async (t) => {
	const fixture = await supervisorFixture(t);
	const supervisor = new AgentSupervisor({
		spawnStore: fixture.store.agentSpawns,
		threadStore: fixture.store.agentThreads,
		taskStore: fixture.store.subagentTasks,
		runtimeFactory: { create: async () => { throw new Error("private failure"); } },
		createTaskId: () => "task-1",
		createThreadId: () => "child-1",
		clock: () => NOW,
	});

	const result = await supervisor.spawn(spawnInput({ mode: "foreground" }));
	assert.equal(result.status, "failed");
	assert.equal(JSON.stringify(result).includes("private failure"), false);
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "failed");
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "failed");
});

test("close interrupts running residents and unloads idle residents", async (t) => {
	const fixture = await supervisorFixture(t);
	const pending = deferred<AgentThreadRuntimeResult>();
	let childIndex = 0;
	const supervisor = new AgentSupervisor({
		spawnStore: fixture.store.agentSpawns,
		threadStore: fixture.store.agentThreads,
		taskStore: fixture.store.subagentTasks,
		runtimeFactory: {
			create: async (input) => input.threadId === "child-running"
				? handle({
					run: async () => pending.promise,
					interrupt: async () => {
						pending.resolve({ status: "interrupted", report: "", usage: {} });
					},
				})
				: handle(),
		},
		createTaskId: () => `task-${++childIndex}`,
		createThreadId: () => childIndex === 1 ? "child-idle" : "child-running",
		clock: () => NOW,
	});
	await supervisor.spawn(spawnInput({ taskName: "idle", mode: "foreground" }));
	await supervisor.spawn(spawnInput({ taskName: "running", mode: "background" }));

	await supervisor.close();
	await supervisor.close();

	assert.equal(fixture.store.agentThreads.get("child-idle")?.status, "unloaded");
	assert.equal(fixture.store.agentThreads.get("child-running")?.status, "interrupted");
});

test("publishes one interrupted terminal event only after runtime cleanup", async (t) => {
	const fixture = await supervisorFixture(t);
	const cleanup = deferred<void>();
	const running = deferred<AgentThreadRuntimeResult>();
	const trace: string[] = [];
	const events: AgentCanonicalEvent[] = [];
	const supervisor = fixture.supervisor(handle({
		run: async () => await running.promise,
		interrupt: async () => {
			await cleanup.promise;
			trace.push("cleanup");
			running.resolve({ status: "interrupted", report: "", usage: {} });
		},
		close: async () => { trace.push("close"); },
	}), {
		onEvent: (event) => {
			events.push(event);
			if (event.type === "agent_lifecycle" && event.kind === "interrupted") {
				trace.push("publish");
			}
		},
	});
	const started = await supervisor.spawn(spawnInput({ mode: "background" }));
	assert.equal(started.status, "running");

	const interrupted = supervisor.interrupt("child-1", "targeted cleanup");
	await new Promise<void>((resolve) => { setImmediate(resolve); });
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "running");
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "running");
	assert.equal(events.filter((event) => event.kind === "interrupted").length, 0);

	cleanup.resolve();
	assert.equal(await interrupted, true);
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "interrupted");
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "interrupted");
	assert.deepEqual(trace, ["cleanup", "close", "publish"]);
	assert.equal(events.filter((event) => event.kind === "interrupted").length, 1);
	assert.equal(await supervisor.interrupt("child-1", "duplicate"), true);
	assert.equal(events.filter((event) => event.kind === "interrupted").length, 1);
});

test("does not terminalize or publish when runtime cleanup is unconfirmed", async (t) => {
	const fixture = await supervisorFixture(t);
	const events: AgentCanonicalEvent[] = [];
	let closed = 0;
	const supervisor = fixture.supervisor(handle({
		run: async () => await new Promise(() => undefined),
		interrupt: async () => { throw new Error("cleanup failed"); },
		close: async () => { closed += 1; },
	}), {
		onEvent: (event) => { events.push(event); },
	});
	const started = await supervisor.spawn(spawnInput({ mode: "background" }));
	assert.equal(started.status, "running");

	assert.equal(await supervisor.interrupt("child-1", "unconfirmed cleanup"), false);
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "running");
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "running");
	assert.equal(events.filter((event) => event.kind === "interrupted").length, 0);
	assert.equal(closed, 0);
});

test("preserves a completed runtime result when interruption loses the terminal race", async (t) => {
	const fixture = await supervisorFixture(t);
	const result = deferred<AgentThreadRuntimeResult>();
	const events: AgentCanonicalEvent[] = [];
	let taskIndex = 0;
	let interrupts = 0;
	let mailboxRuns = 0;
	const supervisor = fixture.supervisor(handle({
		run: async () => await result.promise,
		runMailbox: async () => {
			mailboxRuns += 1;
			return { status: "completed", report: "follow-up", usage: {} };
		},
		interrupt: async () => {
			interrupts += 1;
			result.resolve({ status: "completed", report: "won race", usage: {} });
			throw new Error("interrupt was not applied");
		},
	}), {
		createTaskId: () => `task-${++taskIndex}`,
		onEvent: (event) => { events.push(event); },
	});
	const started = await supervisor.spawn(spawnInput({ mode: "background" }));
	assert.equal(started.status, "running");

	assert.equal(await supervisor.interrupt("child-1", "late interrupt"), false);
	await supervisor.waitFor("child-1");
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "completed");
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "idle");
	assert.equal(events.filter((event) => event.kind === "completed").length, 1);
	assert.equal(events.filter((event) => event.kind === "interrupted").length, 0);
	await waitFor(() => fixture.store.agentThreads.get("child-1")?.status === "idle");
	assert.equal(await supervisor.followUp("child-1", "parent-follow-up", "continue"), true);
	await waitFor(() => mailboxRuns === 1);
	await supervisor.waitFor("child-1");
	assert.equal(fixture.store.subagentTasks.getLatestByChildSession("child-1")?.status, "completed");
	assert.equal(interrupts, 1);
});

test("concurrent spawns cannot oversubscribe the final resident slot", async (t) => {
	const fixture = await supervisorFixture(t);
	const events: AgentCanonicalEvent[] = [];
	const pending = [
		deferred<AgentThreadRuntimeResult>(),
		deferred<AgentThreadRuntimeResult>(),
		deferred<AgentThreadRuntimeResult>(),
	];
	let index = 0;
	const supervisor = new AgentSupervisor({
		spawnStore: fixture.store.agentSpawns,
		threadStore: fixture.store.agentThreads,
		taskStore: fixture.store.subagentTasks,
		runtimeFactory: {
			create: async () => {
				const current = pending[index++]!;
				return handle({
					run: async () => current.promise,
					interrupt: async () => {
						current.resolve({ status: "interrupted", report: "", usage: {} });
					},
				});
			},
		},
		maxResidents: 3,
		createTaskId: (() => {
			let task = 0;
			return () => `capacity-task-${++task}`;
		})(),
		createThreadId: (() => {
			let child = 0;
			return () => `capacity-child-${++child}`;
		})(),
		clock: () => NOW,
		onEvent: (event) => { events.push(event); },
	});

	const [first, second, rejected] = await Promise.all([
		supervisor.spawn(spawnInput({ taskName: "capacity-a", mode: "background" })),
		supervisor.spawn(spawnInput({ taskName: "capacity-b", mode: "background" })),
		supervisor.spawn(spawnInput({ taskName: "capacity-c", mode: "background" })),
	]);
	assert.equal(first.status, "running");
	assert.equal(second.status, "running");
	assert.equal(rejected.status, "failed");
	assert.match(rejected.error ?? "", /^agent_capacity_exhausted:/u);
	assert.equal(fixture.store.agentThreads.list({ rootThreadId: "root-thread" }).length, 2);
	const startedEvents = events.filter((event) => event.kind === "started");
	assert.equal(startedEvents.length, 2);
	assert.equal(new Set(startedEvents.map((event) => event.threadId)).size, 2);
	assert.equal(startedEvents.every((event) => "task" in event && event.task?.taskStatus === "running"), true);

	await supervisor.interrupt(first.childSessionId, "release capacity");
	const replacement = await supervisor.spawn(spawnInput({
		taskName: "capacity-d",
		mode: "background",
	}));
	assert.equal(replacement.status, "running");
	await supervisor.close();
});

test("capacity pressure unloads an idle resident before starting its replacement", async (t) => {
	const fixture = await supervisorFixture(t);
	let closed = 0;
	let child = 0;
	const supervisor = new AgentSupervisor({
		spawnStore: fixture.store.agentSpawns,
		threadStore: fixture.store.agentThreads,
		taskStore: fixture.store.subagentTasks,
		runtimeFactory: {
			create: async () => handle({ close: async () => { closed += 1; } }),
		},
		maxResidents: 2,
		createTaskId: () => `lru-task-${++child}`,
		createThreadId: () => `lru-child-${child}`,
		clock: () => NOW,
	});
	await supervisor.spawn(spawnInput({ taskName: "lru-a", mode: "foreground" }));
	await supervisor.spawn(spawnInput({ taskName: "lru-b", mode: "foreground" }));

	assert.equal(fixture.store.agentThreads.get("lru-child-1")?.status, "unloaded");
	assert.equal(fixture.store.agentThreads.get("lru-child-2")?.status, "idle");
	assert.equal(closed, 1);
	await supervisor.close();
});

test("depth rejection creates no durable child or task", async (t) => {
	const fixture = await supervisorFixture(t);
	const supervisor = fixture.supervisor(handle());
	const result = await supervisor.spawn(spawnInput({
		parentPath: parseAgentPath("/root/parent"),
		taskName: "too-deep",
	}));

	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /^agent_depth_exceeded:/u);
	assert.equal(fixture.store.agentThreads.list({ rootThreadId: "root-thread" }).length, 0);
	assert.equal(fixture.store.subagentTasks.list("parent-session").length, 0);
});

test("wall-clock budget aborts active work with a typed exhaustion result", async (t) => {
	const fixture = await supervisorFixture(t);
	let observedAbort = false;
	const cleanup = deferred<void>();
	const trace: string[] = [];
	const supervisor = fixture.supervisor(handle({
		run: async (_prompt, signal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
				observedAbort = true;
				resolve();
			}, { once: true }));
			return { status: "interrupted", report: "", usage: {} };
		},
		interrupt: async () => {
			await cleanup.promise;
			trace.push("cleanup");
		},
		close: async () => { trace.push("close"); },
	}));
	const resultPromise = supervisor.spawn(spawnInput({
		mode: "foreground",
		config: { ...spawnConfig(), budget: { wallClockMs: 10 } },
	}));
	await waitFor(() => observedAbort);
	assert.equal(fixture.store.subagentTasks.get("task-1")?.status, "running");
	cleanup.resolve();
	const result = await resultPromise;

	assert.equal(result.status, "failed");
	assert.equal(result.error, "agent_budget_exhausted: wall_clock");
	assert.equal(observedAbort, true);
	assert.equal(fixture.store.agentThreads.get("child-1")?.status, "failed");
	assert.deepEqual(trace, ["cleanup", "close"]);
});

async function supervisorFixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-supervisor-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SQLiteSessionStore({ dbPath: join(root, "sessions.db"), clock: () => NOW });
	t.after(() => store.close());
	return {
		store,
		supervisor: (
			runtime: AgentThreadRuntimeHandle,
			overrides: Partial<ConstructorParameters<typeof AgentSupervisor>[0]> = {},
		) => new AgentSupervisor({
			spawnStore: store.agentSpawns,
			threadStore: store.agentThreads,
			taskStore: store.subagentTasks,
			runtimeFactory: { create: async () => runtime },
			createTaskId: () => "task-1",
			createThreadId: () => "child-1",
			createEventId: (() => {
				let index = 0;
				return () => `event-${++index}`;
			})(),
			clock: () => NOW,
			...overrides,
		}),
	};
}

function spawnInput(overrides: Partial<Parameters<AgentSupervisor["spawn"]>[0]> = {}) {
	return {
		parentSessionId: "parent-session",
		parentTurnId: "parent-turn",
		parentThreadId: "root-thread",
		rootThreadId: "root-thread",
		parentPath: rootAgentPath(),
		taskName: "explore",
		profileId: "subagent",
		prompt: "Inspect the repository.",
		config: spawnConfig(),
		...overrides,
	};
}

function spawnConfig(): AgentSpawnConfigSnapshot {
	return {
		workspaceRoot: "/workspace",
		cwd: "/workspace",
		environment: {},
		executionPolicy: {
			trusted: true,
			permission: "workspace",
			sandboxMode: "workspace-write",
			filesystem: "workspace_write",
			network: "disabled",
			writableRoots: ["/workspace"],
		},
		provider: { provider: "openai", protocol: "responses", model: "test-model" },
		instructions: { project: "project", role: "explore" },
		tools: ["Read"],
		forkTurns: "none",
	};
}

function handle(overrides: Partial<AgentThreadRuntimeHandle> = {}): AgentThreadRuntimeHandle {
	return {
		run: overrides.run ?? (async () => ({ status: "completed", report: "done", usage: {} })),
		...(overrides.runMailbox ? { runMailbox: overrides.runMailbox } : {}),
		send: overrides.send ?? (async () => undefined),
		interrupt: overrides.interrupt ?? (async () => undefined),
		close: overrides.close ?? (async () => undefined),
	};
}

function deferred<Value>() {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((settle) => { resolve = settle; });
	return { promise, resolve };
}

async function waitFor(read: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (read()) return;
		await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
	}
	throw new Error("timed out waiting for supervisor state");
}

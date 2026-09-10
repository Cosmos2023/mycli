import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TOOL_RESULT_OUTPUT_MAX_CHARS, type ShellLifecycleEvent } from "@mycli/core";
import {
	DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS,
	executionPolicy,
	resolveShellProfile,
	ShellTool,
	ToolRouter,
	type ShellSessionSnapshot,
	type ShellStartRequest,
} from "../../src/index.ts";

test("Shell routes legacy display metadata without changing execution context", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	const manager = new StartManager(completedSnapshot("x".repeat(50_000)));
	const publishLifecycle: (event: ShellLifecycleEvent) => void = () => undefined;
	const tool = new ShellTool({
		workspaceRoot: root,
		manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/bash" }),
		platform: "linux",
		env: { PATH: "/usr/bin" },
		createChunkId: () => "chunk-1",
	});
	assert.equal(tool.supportsParallelToolCalls, true);
	const router = new ToolRouter({ adapters: [tool], exposure: [tool.definition] });

	const result = await router.execute({
		callId: "call-shell-1",
		name: "Shell",
		argumentsJson: JSON.stringify({
			command: "printf ready",
			description: "  Print the readiness marker  ",
			justification: "Verify that the local command runner is ready.",
		}),
	}, {
		signal: new AbortController().signal,
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		publishLifecycle,
		executionPolicy: executionPolicy("full-access", root),
	});

	assert.equal(manager.starts.length, 1);
	const request = manager.starts[0];
	assert.ok(request);
	assert.equal(request.cwd, await realpath(root));
	assert.equal(request.executable, "/bin/bash");
	assert.deepEqual(request.args, ["-lc", "printf ready"]);
	assert.equal(request.description, "Print the readiness marker");
	assert.equal("justification" in request, false);
	assert.equal(request.yieldTimeMs, 10_000);
	assert.deepEqual({
		ownerSessionId: request.ownerSessionId,
		callId: request.callId,
		publishLifecycle: request.publishLifecycle,
	}, {
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		publishLifecycle,
	});
	assert.equal(result.success, true);
	assert.equal(result.modelOutput.length, DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS);
	assert.match(result.modelOutput, /Process exited with code 0/u);
	assert.equal(JSON.stringify(result.metadata).includes("printf ready"), false);
	assert.equal(result.summary.includes("printf ready"), false);
});

test("Shell rejects invalid descriptions and approval reasons before manager start", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	const manager = new StartManager(completedSnapshot());
	const tool = new ShellTool({
		workspaceRoot: root,
		manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
		platform: "linux",
	});
	const router = new ToolRouter({ adapters: [tool], exposure: [tool.definition] });

	for (const field of ["description", "justification"]) for (const value of [null, 42, "   ", "x".repeat(513)]) {
		const result = await router.execute({
			callId: "call-invalid",
			name: "Shell",
			argumentsJson: JSON.stringify({ command: "true", [field]: value }),
		}, executionOptions(root));
		assert.equal(result.errorKind, "invalid_arguments");
	}
	for (const args of [
		{ description: "Legacy command summary" },
		{ command: "true", description: "Legacy command summary", unexpected: true },
		{ command: "true", description: "Legacy command summary", sandbox_permissions: "host" },
	]) {
		const result = await router.execute({
			callId: "call-invalid-legacy", name: "Shell", argumentsJson: JSON.stringify(args),
		}, executionOptions(root));
		assert.equal(result.errorKind, "invalid_arguments");
	}
	assert.equal(manager.starts.length, 0);
});

test("Shell resolves an in-workspace cwd and clamps yield and output budget", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	const work = join(root, "nested");
	await mkdir(work);
	const manager = new StartManager(completedSnapshot("x".repeat(50_000)));
	const tool = new ShellTool({
		workspaceRoot: root,
		manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
		platform: "linux",
		createChunkId: () => "chunk-2",
	});

	const result = await tool.execute({
		command: "true",
		cwd: "nested",
		tty: true,
		yield_time_ms: 1,
		max_output_tokens: 50_000,
	}, executionOptions(root));

	assert.equal(manager.starts[0]?.cwd, await realpath(work));
	assert.equal(manager.starts[0]?.tty, true);
	assert.equal(manager.starts[0]?.yieldTimeMs, 250);
	assert.equal(result.modelOutput.length, TOOL_RESULT_OUTPUT_MAX_CHARS);
});

test("Shell output budgets can grow above the default while respecting runtime and persistence limits", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-budget-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	const manager = new StartManager(completedSnapshot(`output-start\n${"x".repeat(50_000)}\noutput-end`));
	const tool = new ShellTool({
		workspaceRoot: root, manager, platform: "linux",
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
	});
	const router = new ToolRouter({ adapters: [tool], exposure: [tool.definition] });
	for (const [tokens, expectedChars] of [
		[undefined, DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS],
		[125, 500],
		[1_000, 4_000],
		[2_000, TOOL_RESULT_OUTPUT_MAX_CHARS],
		[50_000, TOOL_RESULT_OUTPUT_MAX_CHARS],
	] as const) {
		const result = await router.execute({
			callId: "call-budget", name: "Shell",
			argumentsJson: JSON.stringify({ command: "true", max_output_tokens: tokens }),
		}, executionOptions(root));
		assert.equal(result.modelOutput.length, expectedChars);
		assert.match(result.modelOutput, /output-start/u);
		assert.match(result.modelOutput, /output-end$/u);
	}
	assert.equal((await tool.executeLegacy({ command: "true" }, executionOptions(root))).modelOutput.length,
		DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS);
	for (const maximum of [250, 750, 10_000]) {
		const capped = new ShellTool({
			workspaceRoot: root, manager, platform: "linux", maxOutputTokens: maximum,
			profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
		});
		const defaultResult = await capped.execute({ command: "true" }, executionOptions(root));
		const requested = await capped.execute({ command: "true", max_output_tokens: 10_000 }, executionOptions(root));
		assert.equal(defaultResult.modelOutput.length, Math.min(DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS, maximum * 4));
		assert.equal(requested.modelOutput.length, Math.min(TOOL_RESULT_OUTPUT_MAX_CHARS, maximum * 4));
	}
});

test("Shell retains its foreground wait and exact invocation across approval", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	const manager = new StartManager({
		...completedSnapshot(), status: "running", processState: "running_background",
		background: true, yielded: true, terminalState: undefined, exitCode: undefined,
	});
	const tool = new ShellTool({
		workspaceRoot: root, manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }), platform: "linux",
	});
	const args = Object.freeze({ command: "printf ready", yield_time_ms: 30_000, tty: true });
	const result = await tool.execute(args, {
		...executionOptions(root), ownerTurnId: "turn-approved",
	});
	assert.equal(manager.starts[0]?.yieldTimeMs, 30_000);
	assert.equal(manager.starts[0]?.ownerTurnId, "turn-approved");
	assert.equal(manager.starts[0]?.background, undefined);
	assert.equal(manager.starts[0]?.command, args.command);
	assert.equal(manager.starts[0]?.tty, true);
	assert.equal(args.yield_time_ms, 30_000);
	assert.match(result.modelOutput, /Process running with session ID a1b2c3d4/u);
	assert.equal(result.metadata.process_state, "running_background");
	assert.equal(result.metadata.yielded, true);

	await tool.execute(args, executionOptions(root));
	assert.equal(manager.starts[1]?.yieldTimeMs, 30_000);
	await tool.executeLegacy({ command: "printf ready" }, executionOptions(root));
	assert.equal(manager.starts[2]?.background, false);
	assert.equal(manager.starts[2]?.yieldTimeMs, 10_000);
	const invalid = await tool.execute({ ...args, yield_time_ms: 0 }, {
		...executionOptions(root),
	});
	assert.equal(invalid.errorKind, "invalid_yield_time");
	assert.equal(manager.starts.length, 3);
});

test("Shell confines workspace cwd and allows an outside cwd only with full access", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(parent, { recursive: true, force: true })));
	const root = join(parent, "workspace");
	const outside = join(parent, "outside");
	await Promise.all([mkdir(root), mkdir(outside)]);
	const manager = new StartManager(completedSnapshot());
	const tool = new ShellTool({
		workspaceRoot: root,
		manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
		createChunkId: () => "chunk-3",
	});

	const escaped = await tool.execute({ command: "pwd", cwd: outside }, {
		...executionOptions(root),
		executionPolicy: executionPolicy("workspace", root),
	});
	const invalidBudget = await tool.execute({
		command: "pwd",
		max_output_tokens: 0,
	}, executionOptions(root));
	const unrestricted = await tool.execute({ command: "pwd", cwd: outside }, executionOptions(root));

	assert.equal(escaped.errorKind, "workspace_escape");
	assert.equal(invalidBudget.errorKind, "invalid_output_budget");
	assert.equal(unrestricted.success, true);
	assert.equal(manager.starts.length, 1);
	assert.equal(manager.starts[0]?.cwd, await realpath(outside));
});

test("Shell requires runtime authorization before using an escalated process profile", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(parent, { recursive: true, force: true })));
	const root = join(parent, "workspace");
	const outside = join(parent, "outside");
	await Promise.all([mkdir(root), mkdir(outside)]);
	const manager = new StartManager(completedSnapshot());
	const tool = new ShellTool({
		workspaceRoot: root,
		manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
		platform: "linux",
		processSandboxProbes: { platform: "linux", isExecutable: () => false },
	});
	const restricted = {
		...executionOptions(root),
		executionPolicy: executionPolicy("workspace", root),
	};

	const forged = await tool.execute({
		command: "pwd",
		cwd: outside,
		sandbox_permissions: "require_escalated",
	}, restricted);
	const invalid = await tool.execute({
		command: "pwd",
		sandbox_permissions: "host",
	}, restricted);
	const approved = await tool.execute({
		command: "pwd",
		cwd: outside,
		sandbox_permissions: "require_escalated",
	}, {
		...restricted,
		sandboxOverrideApproved: true,
	});
	const constrained = await tool.execute({
		command: "pwd",
		cwd: outside,
		sandbox_permissions: "require_escalated",
	}, {
		...restricted,
		sandboxOverrideApproved: true,
		sandboxOverridePolicy: {
			...executionPolicy("full-access", root),
			networkDomains: ["api.example.com"],
		},
	});

	assert.equal(forged.errorKind, "sandbox_override_not_approved");
	assert.equal(invalid.errorKind, "invalid_sandbox_permissions");
	assert.equal(approved.success, true);
	assert.equal(constrained.errorKind, "sandbox_unavailable");
	assert.equal(manager.starts.length, 1);
	assert.equal(manager.starts[0]?.executable, "/bin/sh");
	assert.equal(manager.starts[0]?.cwd, await realpath(outside));
});

test("Shell freezes proxy authority before async preparation and transfers process ownership", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-proxy-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	let closed = false;
	let domainsSeen: readonly string[] = [];
	const proxy = { port: 40_000, env: { HTTP_PROXY: "http://127.0.0.1:40000", NO_PROXY: "" },
		close: async () => { closed = true; } };
	const manager = new StartManager(completedSnapshot());
	const tool = new ShellTool({
		workspaceRoot: root, manager, platform: "darwin",
		profile: resolveShellProfile({ platform: "darwin", shellPath: "/bin/sh" }),
		processSandboxProbes: { isExecutable: () => true },
		env: { PATH: "/usr/bin", HTTP_PROXY: "http://elsewhere.test", NO_PROXY: "*" },
		networkProxyFactory: async (domains) => { domainsSeen = domains; return proxy; },
	});
	const domains = ["api.example.com"];
	const pending = tool.execute({ command: "true" }, {
		...executionOptions(root), executionPolicy: { ...executionPolicy("workspace", root), network: "enabled", networkDomains: domains },
	});
	domains.push("outside.test");
	assert.equal((await pending).success, true);
	assert.deepEqual(domainsSeen, ["api.example.com"]);
	assert.equal(Object.isFrozen(domainsSeen), true);
	assert.equal(manager.starts[0]?.processResource, proxy);
	assert.equal(manager.starts[0]?.env.HTTP_PROXY, "http://127.0.0.1:40000");
	assert.equal(manager.starts[0]?.env.NO_PROXY, "");
	assert.equal(closed, false);
	await manager.starts[0]?.processResource?.close();
});

test("Shell rejects unsupported proxy platforms and never creates a proxy when networking is disabled", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-proxy-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	for (const platform of ["linux", "win32"] as const) {
		let proxies = 0;
		const manager = new StartManager(completedSnapshot());
		const tool = new ShellTool({
			workspaceRoot: root, manager, platform,
			profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
			processSandboxProbes: { isExecutable: () => true },
			networkProxyFactory: async () => { proxies += 1; throw new Error("unexpected proxy"); },
		});
		const result = await tool.execute({ command: "true" }, {
			...executionOptions(root), executionPolicy: { ...executionPolicy("full-access", root), networkDomains: ["api.example.com"] },
		});
		assert.equal(result.errorKind, "network_proxy_unavailable");
		assert.equal(manager.starts.length, 0);
		for (const policy of [
			{ ...executionPolicy("workspace", root), networkDomains: ["api.example.com"] },
			{ ...executionPolicy("workspace", root), network: "enabled" as const, networkDomains: [] },
		]) {
			assert.equal((await tool.execute({ command: "true" }, { ...executionOptions(root), executionPolicy: policy })).success, true);
		}
		assert.equal(proxies, 0);
	}
});

test("full filesystem access and model escalation cannot discard an existing network bound", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-proxy-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	for (const approved of [false, true]) {
		const manager = new StartManager(completedSnapshot());
		let domainsSeen: readonly string[] = [];
		const tool = new ShellTool({
			workspaceRoot: root, manager, platform: "darwin",
			profile: resolveShellProfile({ platform: "darwin", shellPath: "/bin/sh" }),
			processSandboxProbes: { isExecutable: () => true },
			networkProxyFactory: async (domains) => {
				domainsSeen = domains;
				return { port: 40_000, env: {}, close: async () => undefined };
			},
		});
		const result = await tool.execute({ command: "true; true", sandbox_permissions: "require_escalated" }, {
			...executionOptions(root), sandboxOverrideApproved: approved,
			executionPolicy: { ...executionPolicy("full-access", root), networkDomains: ["api.example.com"] },
		});
		assert.equal(result.success, true);
		assert.deepEqual(domainsSeen, ["api.example.com"]);
		assert.equal(manager.starts[0]?.executable, "/usr/bin/sandbox-exec");
	}
});

test("Shell closes a prepared proxy when launch validation fails or cancellation arrives", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-proxy-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	for (const aborted of [false, true]) {
		let closed = false;
		const controller = new AbortController();
		const manager = new StartManager(completedSnapshot());
		const tool = new ShellTool({
			workspaceRoot: root, manager, platform: "darwin",
			profile: resolveShellProfile({ platform: "darwin", shellPath: "/bin/sh" }),
			processSandboxProbes: { isExecutable: () => true },
			networkProxyFactory: async () => {
				if (aborted) controller.abort();
				return { port: 0, env: {}, close: async () => { closed = true; } };
			},
		});
		const pending = tool.execute({ command: "true" }, {
			...executionOptions(root), signal: controller.signal,
			executionPolicy: { ...executionPolicy("full-access", root), networkDomains: ["api.example.com"] },
		});
		if (aborted) await assert.rejects(pending, { name: "AbortError" });
		else assert.equal((await pending).errorKind, "network_proxy_unavailable");
		assert.equal(closed, true);
		assert.equal(manager.starts.length, 0);
	}
});

test("Shell sanitizes environment and applies the frozen sandbox before manager start", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	const canonicalRoot = await realpath(root);
	const manager = new StartManager(completedSnapshot());
	const tool = new ShellTool({
		workspaceRoot: root,
		manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
		platform: "linux",
		env: {
			HOME: "/home/demo",
			PATH: "/usr/bin",
			MYCLI_TOKEN: "must-not-reach-child",
			CUSTOM: "drop-me",
		},
		processSandboxProbes: {
			platform: "linux",
			isExecutable: (path) => path === "/usr/bin/bwrap",
		},
	});

	const result = await tool.execute({ command: "printf ready" }, {
		...executionOptions(root),
		executionPolicy: executionPolicy("workspace", root),
	});

	assert.equal(result.success, true);
	assert.equal(manager.starts[0]?.executable, "/usr/bin/bwrap");
	assert.deepEqual(manager.starts[0]?.args.slice(0, 5), [
		"--new-session",
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
	]);
	assert.deepEqual(manager.starts[0]?.env, {
		HOME: "/home/demo",
		MYCLI_CI: "1",
		PATH: "/usr/bin",
		PWD: canonicalRoot,
	});
	assert.equal(JSON.stringify(manager.starts[0]?.env).includes("must-not-reach-child"), false);
});

test("Shell fails before manager start when a restricted sandbox is unavailable", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	const manager = new StartManager(completedSnapshot());
	const tool = new ShellTool({
		workspaceRoot: root,
		manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
		platform: "linux",
		processSandboxProbes: { platform: "linux", isExecutable: () => false },
	});

	const result = await tool.execute({ command: "true" }, {
		...executionOptions(root),
		executionPolicy: executionPolicy("workspace", root),
	});

	assert.equal(result.errorKind, "sandbox_unavailable");
	assert.equal(manager.starts.length, 0);
});

class StartManager {
	readonly starts: ShellStartRequest[] = [];

	constructor(readonly snapshot: ShellSessionSnapshot) {}

	async start(request: ShellStartRequest): Promise<ShellSessionSnapshot> {
		this.starts.push(request);
		return this.snapshot;
	}

}

function executionOptions(workspaceRoot: string) {
	return {
		signal: new AbortController().signal,
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		publishLifecycle: (): void => undefined,
		executionPolicy: executionPolicy("full-access", workspaceRoot),
	};
}

function completedSnapshot(output = "ready\n"): ShellSessionSnapshot {
	return {
		success: true,
		shellId: "a1b2c3d4",
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		background: false,
		status: "exited",
		processState: "completed",
		terminalState: "completed",
		exitCode: 0,
		output,
		stdout: output,
		stderr: "",
		nextCursor: output.length,
		outputChars: output.length,
		newOutputChars: output.length,
		omittedOutputChars: 0,
		stdoutChars: output.length,
		stderrChars: 0,
		stdoutOmittedChars: 0,
		stderrOmittedChars: 0,
		cursorWasEvicted: false,
		transport: "pipe",
		tty: false,
		yielded: false,
		decodeReplacementCount: 0,
		wallTimeSeconds: 0.25,
	};
}

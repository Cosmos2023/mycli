import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ShellLifecycleEvent } from "@mycli/core";
import {
	DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS,
	executionPolicy,
	resolveShellProfile,
	ShellTool,
	type ShellSessionSnapshot,
	type ShellStartRequest,
} from "../src/index.ts";

test("Shell accepts a display-only description without changing execution context", async (t) => {
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

	const result = await tool.execute({
		command: "printf ready",
		description: "  Print the readiness marker  ",
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

test("Shell rejects invalid descriptions before manager start", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	const manager = new StartManager(completedSnapshot());
	const tool = new ShellTool({
		workspaceRoot: root,
		manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/sh" }),
		platform: "linux",
	});

	for (const description of [42, "   ", "x".repeat(513)]) {
		const result = await tool.execute({ command: "true", description }, executionOptions(root));
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
	assert.equal(result.modelOutput.length, DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS);
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

	assert.equal(forged.errorKind, "sandbox_override_not_approved");
	assert.equal(invalid.errorKind, "invalid_sandbox_permissions");
	assert.equal(approved.success, true);
	assert.equal(manager.starts.length, 1);
	assert.equal(manager.starts[0]?.executable, "/bin/sh");
	assert.equal(manager.starts[0]?.cwd, await realpath(outside));
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

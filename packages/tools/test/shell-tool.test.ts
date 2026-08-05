import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ShellLifecycleEvent } from "@mycli/core";
import {
	resolveShellProfile,
	ShellTool,
	type ShellSessionSnapshot,
	type ShellStartRequest,
} from "../src/index.ts";

test("Shell defaults cwd and forwards immutable execution context", async (t) => {
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

	const result = await tool.execute({ command: "printf ready" }, {
		signal: new AbortController().signal,
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		publishLifecycle,
	});

	assert.equal(manager.starts.length, 1);
	const request = manager.starts[0];
	assert.ok(request);
	assert.equal(request.cwd, await realpath(root));
	assert.equal(request.executable, "/bin/bash");
	assert.deepEqual(request.args, ["-lc", "printf ready"]);
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
	assert.match(result.modelOutput, /Process exited with code 0/u);
	assert.equal(JSON.stringify(result.metadata).includes("printf ready"), false);
	assert.equal(result.summary.includes("printf ready"), false);
});

test("Shell resolves an in-workspace cwd and clamps yield and output budget", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-tool-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
	const work = join(root, "nested");
	await mkdir(work);
	const manager = new StartManager(completedSnapshot());
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
	}, executionOptions());

	assert.equal(manager.starts[0]?.cwd, await realpath(work));
	assert.equal(manager.starts[0]?.tty, true);
	assert.equal(manager.starts[0]?.yieldTimeMs, 250);
	assert.ok(result.modelOutput.length <= 40_000);
});

test("Shell rejects escaped cwd and invalid output budget before manager start", async (t) => {
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

	const escaped = await tool.execute({ command: "pwd", cwd: outside }, executionOptions());
	const invalidBudget = await tool.execute({
		command: "pwd",
		max_output_tokens: 0,
	}, executionOptions());

	assert.equal(escaped.errorKind, "workspace_escape");
	assert.equal(invalidBudget.errorKind, "invalid_output_budget");
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

function executionOptions() {
	return {
		signal: new AbortController().signal,
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		publishLifecycle: (): void => undefined,
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

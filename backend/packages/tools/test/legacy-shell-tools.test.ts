import assert from "node:assert/strict";
import test from "node:test";
import {
	BashOutputTool,
	BashTool,
	executionPolicy,
	KillShellTool,
	resolveShellProfile,
	ShellOutputTool,
	ShellTool,
	type ShellInteractionRequest,
	type ShellSessionSnapshot,
	type ShellStartRequest,
} from "../src/index.ts";

test("legacy Bash delegates background and timeout arguments to Shell manager", async () => {
	const manager = new LegacyManager(runningSnapshot());
	const shell = new ShellTool({
		workspaceRoot: process.cwd(),
		manager,
		profile: resolveShellProfile({ platform: "linux", shellPath: "/bin/bash" }),
		createChunkId: () => "chunk-bash",
	});
	const bash = new BashTool({ shell });

	await bash.execute({
		command: "npm test",
		timeout: 12,
		run_in_background: true,
	}, executionOptions());

	assert.equal(manager.starts.length, 1);
	assert.equal(manager.starts[0]?.background, true);
	assert.equal(manager.starts[0]?.timeoutSeconds, 12);
	assert.deepEqual(manager.starts[0]?.args, ["-lc", "npm test"]);
});

test("legacy output aliases poll immediately and KillShell terminates by owner", async () => {
	const manager = new LegacyManager(runningSnapshot());
	const shellOutput = new ShellOutputTool({ manager, createChunkId: () => "chunk-output" });
	const bashOutput = new BashOutputTool({ manager, createChunkId: () => "chunk-output" });
	const kill = new KillShellTool({ manager, createChunkId: () => "chunk-kill" });

	await shellOutput.execute({ shell_id: "a1b2c3d4" }, executionOptions());
	await bashOutput.execute({ bash_id: "a1b2c3d4" }, executionOptions());
	const killed = await kill.execute({ bash_id: "a1b2c3d4" }, executionOptions());

	assert.deepEqual(manager.interactions.map((request) => ({
		shellId: request.shellId,
		chars: request.chars,
		yieldTimeMs: request.yieldTimeMs,
	})), [
		{ shellId: "a1b2c3d4", chars: "", yieldTimeMs: 0 },
		{ shellId: "a1b2c3d4", chars: "", yieldTimeMs: 0 },
	]);
	assert.deepEqual(manager.terminations, [{
		ownerSessionId: "session-a",
		shellId: "a1b2c3d4",
	}]);
	assert.equal(killed.success, true);
	assert.equal(killed.summary.includes("npm test"), false);
});

class LegacyManager {
	readonly starts: ShellStartRequest[] = [];
	readonly interactions: ShellInteractionRequest[] = [];
	readonly terminations: Array<{ readonly ownerSessionId: string; readonly shellId: string }> = [];

	constructor(readonly snapshot: ShellSessionSnapshot) {}

	async start(request: ShellStartRequest): Promise<ShellSessionSnapshot> {
		this.starts.push(request);
		return this.snapshot;
	}

	async interact(request: ShellInteractionRequest): Promise<ShellSessionSnapshot> {
		this.interactions.push(request);
		return this.snapshot;
	}

	async terminate(ownerSessionId: string, shellId: string): Promise<ShellSessionSnapshot> {
		this.terminations.push({ ownerSessionId, shellId });
		return { ...this.snapshot, terminalState: "killed", processState: "killed" };
	}
}

function executionOptions() {
	return {
		signal: new AbortController().signal,
		ownerSessionId: "session-a",
		callId: "call-legacy-1",
		publishLifecycle: (): void => undefined,
		executionPolicy: executionPolicy("full-access", process.cwd()),
	};
}

function runningSnapshot(): ShellSessionSnapshot {
	return {
		success: true,
		shellId: "a1b2c3d4",
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		background: true,
		status: "running",
		processState: "running_background",
		output: "ready\n",
		stdout: "ready\n",
		stderr: "",
		nextCursor: 6,
		outputChars: 6,
		newOutputChars: 6,
		omittedOutputChars: 0,
		stdoutChars: 6,
		stderrChars: 0,
		stdoutOmittedChars: 0,
		stderrOmittedChars: 0,
		cursorWasEvicted: false,
		transport: "pipe",
		tty: false,
		yielded: true,
		decodeReplacementCount: 0,
		wallTimeSeconds: 1,
	};
}

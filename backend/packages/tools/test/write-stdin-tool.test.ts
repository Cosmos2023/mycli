import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS,
	type ShellInteractionRequest,
	type ShellSessionSnapshot,
	WriteStdinTool,
} from "../src/index.ts";

test("WriteStdin accepts legacy ids and applies poll and input wait bounds", async () => {
	const manager = new InteractionManager(runningSnapshot("x".repeat(50_000)));
	const tool = new WriteStdinTool({
		manager,
		createChunkId: () => "chunk-stdin",
	});

	await tool.execute({ shell_id: "a1b2c3d4", yield_time_ms: 1 }, executionOptions());
	const input = await tool.execute({
		bash_id: "a1b2c3d4",
		chars: "private-input\n",
		yield_time_ms: 300_001,
		max_output_tokens: 50_000,
	}, executionOptions());

	assert.deepEqual(manager.interactions.map((request) => ({
		ownerSessionId: request.ownerSessionId,
		shellId: request.shellId,
		chars: request.chars,
		yieldTimeMs: request.yieldTimeMs,
	})), [
		{ ownerSessionId: "session-a", shellId: "a1b2c3d4", chars: "", yieldTimeMs: 5_000 },
		{
			ownerSessionId: "session-a",
			shellId: "a1b2c3d4",
			chars: "private-input\n",
			yieldTimeMs: 30_000,
		},
	]);
	assert.equal(input.modelOutput.length, DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS);
	assert.equal(input.summary.includes("private-input"), false);
	assert.equal(JSON.stringify(input.metadata).includes("private-input"), false);
});

test("WriteStdin rejects invalid ids, chars, and output budgets", async () => {
	const manager = new InteractionManager(runningSnapshot());
	const tool = new WriteStdinTool({ manager });

	const missing = await tool.execute({}, executionOptions());
	const chars = await tool.execute({ session_id: "a1b2c3d4", chars: 42 }, executionOptions());
	const budget = await tool.execute({
		session_id: "a1b2c3d4",
		max_output_tokens: false,
	}, executionOptions());

	assert.equal(missing.errorKind, "missing_shell_id");
	assert.equal(chars.errorKind, "invalid_chars");
	assert.equal(budget.errorKind, "invalid_output_budget");
	assert.equal(manager.interactions.length, 0);
});

class InteractionManager {
	readonly interactions: ShellInteractionRequest[] = [];

	constructor(readonly snapshot: ShellSessionSnapshot) {}

	async interact(request: ShellInteractionRequest): Promise<ShellSessionSnapshot> {
		this.interactions.push(request);
		return this.snapshot;
	}

}

function executionOptions() {
	return {
		signal: new AbortController().signal,
		ownerSessionId: "session-a",
		callId: "call-stdin-1",
		publishLifecycle: (): void => undefined,
	};
}

function runningSnapshot(output = "ready\n"): ShellSessionSnapshot {
	return {
		success: true,
		shellId: "a1b2c3d4",
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		background: true,
		status: "running",
		processState: "running_background",
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
		transport: "unix_pty",
		tty: true,
		yielded: true,
		decodeReplacementCount: 0,
		wallTimeSeconds: 1,
	};
}

import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import {
	DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS,
	type ShellInteractionRequest,
	type ShellSessionSnapshot,
	WriteStdinTool,
} from "../../src/index.ts";

test("WriteStdin accepts legacy ids and applies poll and input wait bounds", async () => {
	const manager = new InteractionManager(runningSnapshot("x".repeat(50_000)));
	const tool = new WriteStdinTool({
		manager,
		createChunkId: () => "chunk-stdin",
	});

	await tool.execute({ shell_id: "a1b2c3d4", yield_time_ms: 1 }, executionOptions());
	const input = await tool.execute({
		bash_id: "a1b2c3d4",
		chars: "token=private-input\n",
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
			chars: "token=private-input\n",
			yieldTimeMs: 30_000,
		},
	]);
	assert.equal(input.modelOutput.length, TOOL_RESULT_OUTPUT_MAX_CHARS);
	assert.equal(input.summary.includes("private-input"), false);
	assert.equal(JSON.stringify(input.metadata).includes("private-input"), false);
	assert.deepEqual(input.metadata.terminal_interaction, {
		shell_id: "a1b2c3d4", kind: "input", input_preview: '"token=[REDACTED]',
		interaction_succeeded: true, process_running: true,
	});
});

test("WriteStdin budgets distinguish the default, requested amount, and runtime maximum", async () => {
	const manager = new InteractionManager(runningSnapshot(`output-start\n${"x".repeat(50_000)}\noutput-end`));
	const tool = new WriteStdinTool({ manager });
	for (const [tokens, expectedChars] of [
		[undefined, DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS],
		[125, 500],
		[1_000, 4_000],
		[2_000, TOOL_RESULT_OUTPUT_MAX_CHARS],
		[50_000, TOOL_RESULT_OUTPUT_MAX_CHARS],
	] as const) {
		const result = await tool.execute({ session_id: "a1b2c3d4", max_output_tokens: tokens }, executionOptions());
		assert.equal(result.modelOutput.length, expectedChars);
		assert.match(result.modelOutput, /output-start/u);
		assert.match(result.modelOutput, /output-end$/u);
	}
	for (const maximum of [250, 750, 10_000]) {
		const capped = new WriteStdinTool({ manager, maxOutputTokens: maximum });
		const defaultResult = await capped.execute({ session_id: "a1b2c3d4" }, executionOptions());
		const requested = await capped.execute({ session_id: "a1b2c3d4", max_output_tokens: 10_000 }, executionOptions());
		assert.equal(defaultResult.modelOutput.length, Math.min(DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS, maximum * 4));
		assert.equal(requested.modelOutput.length, Math.min(TOOL_RESULT_OUTPUT_MAX_CHARS, maximum * 4));
	}
});

test("WriteStdin records successful input even when it interrupts or completes the process", async () => {
	const snapshot = { ...runningSnapshot(), terminalState: "interrupted", status: "exited" as const,
		processState: "interrupted", exitCode: 130, commandPreview: "node wait-input.cjs" };
	const tool = new WriteStdinTool({ manager: new InteractionManager(snapshot) });
	const result = await tool.execute({ session_id: snapshot.shellId, chars: "\u0003" }, executionOptions());
	assert.equal(result.success, false);
	assert.deepEqual(result.metadata.terminal_interaction, {
		shell_id: snapshot.shellId, kind: "input", input_preview: '"^C"',
		command_preview: "node wait-input.cjs", interaction_succeeded: true, process_running: false,
	});
	const polled = await tool.execute({ session_id: snapshot.shellId }, executionOptions());
	assert.deepEqual(polled.metadata.terminal_interaction, {
		shell_id: snapshot.shellId, kind: "poll", command_preview: "node wait-input.cjs",
		interaction_succeeded: true, process_running: false,
	});
});

test("WriteStdin retains a failed interaction without claiming that input was sent", async () => {
	const snapshot = { ...runningSnapshot(), success: false, status: "error" as const,
		errorKind: "shell_write_failed", error: "Unable to write to shell session." };
	const tool = new WriteStdinTool({ manager: new InteractionManager(snapshot) });
	const result = await tool.execute({ session_id: snapshot.shellId, chars: "y\n" }, executionOptions());
	assert.equal(result.success, false);
	assert.equal(result.errorKind, "shell_write_failed");
	assert.deepEqual(result.metadata.terminal_interaction, {
		shell_id: snapshot.shellId, kind: "input", input_preview: '"y\\n"', interaction_succeeded: false,
	});
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

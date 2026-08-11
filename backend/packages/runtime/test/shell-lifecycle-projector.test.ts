import assert from "node:assert/strict";
import test from "node:test";
import type { ShellLifecycleEvent } from "@mycli/core";
import type { UpsertShellSnapshotInput } from "@mycli/storage";
import { ShellLifecycleProjector } from "../src/index.ts";

test("persists each shell snapshot before publishing the lifecycle event", async () => {
	const order: string[] = [];
	const writes: UpsertShellSnapshotInput[] = [];
	const projector = new ShellLifecycleProjector({
		store: {
			upsertShellSnapshot: (input) => {
				writes.push(input);
				order.push(`persist:${String(input.payload.kind)}`);
			},
		},
	});
	projector.subscribe((event) => { order.push(`publish:${event.kind}`); });

	await projector.accept(shellEvent({ kind: "shell.completed", terminalState: "completed" }));

	assert.deepEqual(order, ["persist:shell.completed", "publish:shell.completed"]);
	assert.equal(writes[0]?.sessionId, "session-a");
	assert.equal(writes[0]?.callId, "call-shell-1");
});

test("accumulates bounded output and ignores stale event sequences", async () => {
	const writes: UpsertShellSnapshotInput[] = [];
	const published: ShellLifecycleEvent[] = [];
	const projector = new ShellLifecycleProjector({
		store: { upsertShellSnapshot: (input) => { writes.push(input); } },
	});
	projector.subscribe((event) => { published.push(event); });

	projector.enqueue(shellEvent({
		kind: "shell.output",
		sequence: 2,
		outputDelta: "ready",
		nextCursor: 5,
	}));
	projector.enqueue(shellEvent({
		kind: "shell.output",
		sequence: 1,
		outputDelta: "stale",
		nextCursor: 5,
	}));
	projector.enqueue(shellEvent({
		kind: "shell.output",
		sequence: 3,
		outputDelta: "\ndone",
		nextCursor: 10,
	}));
	await projector.drain();

	assert.equal(writes.length, 2);
	assert.equal(writes.at(-1)?.payload.output, "ready\ndone");
	assert.deepEqual(writes.map((write) => write.outputChunk), [
		{
			sequence: 2,
			cursorStart: 0,
			cursorEnd: 5,
			omittedBefore: 0,
			output: "ready",
		},
		{
			sequence: 3,
			cursorStart: 5,
			cursorEnd: 10,
			omittedBefore: 0,
			output: "\ndone",
		},
	]);
	assert.deepEqual(published.map((event) => event.sequence), [2, 3]);
});

test("records lifecycle cursor gaps without copying omitted output into the snapshot", async () => {
	const writes: UpsertShellSnapshotInput[] = [];
	const projector = new ShellLifecycleProjector({
		store: { upsertShellSnapshot: (input) => { writes.push(input); } },
	});

	await projector.accept(shellEvent({
		kind: "shell.output",
		sequence: 2,
		outputDelta: "tail",
		nextCursor: 100,
		omittedOutputChars: 96,
	}));

	assert.deepEqual(writes[0]?.outputChunk, {
		sequence: 2,
		cursorStart: 96,
		cursorEnd: 100,
		omittedBefore: 96,
		output: "tail",
	});
});

test("redacts sensitive command previews before persistence and publication", async () => {
	const writes: UpsertShellSnapshotInput[] = [];
	const published: ShellLifecycleEvent[] = [];
	const projector = new ShellLifecycleProjector({
		store: { upsertShellSnapshot: (input) => { writes.push(input); } },
	});
	projector.subscribe((event) => { published.push(event); });

	await projector.accept(shellEvent({
		commandPreview: "MY_API_KEY=private-value npm test",
	}));

	assert.equal(writes[0]?.payload.command_preview, "[redacted command]");
	assert.equal(published[0]?.commandPreview, "[redacted command]");
});

test("projects retained output only for a completed background shell", async () => {
	const projected: unknown[] = [];
	const projector = new ShellLifecycleProjector({
		store: { upsertShellSnapshot: () => undefined },
		projectTaskOutput: (input) => { projected.push(input); },
	});

	await projector.accept(shellEvent({ kind: "shell.output", outputDelta: "working" }));
	await projector.accept(shellEvent({
		kind: "shell.completed",
		sequence: 2,
		outputDelta: "\ndone",
		terminalState: "completed",
	}));
	await projector.accept(shellEvent({
		kind: "shell.completed",
		shellId: "foreground-shell",
		callId: "foreground-call",
		background: false,
		terminalState: "completed",
		outputDelta: "foreground",
	}));

	assert.deepEqual(projected, [{
		sessionId: "session-a",
		taskId: "a1b2c3d4",
		output: "working\ndone",
	}]);
});

test("contains background task output projection failures", async () => {
	const errors: unknown[] = [];
	const projector = new ShellLifecycleProjector({
		store: { upsertShellSnapshot: () => undefined },
		projectTaskOutput: () => { throw new Error("artifact unavailable"); },
		onError: (error) => { errors.push(error); },
	});

	await projector.accept(shellEvent({ kind: "shell.completed", terminalState: "completed" }));

	assert.equal(errors.length, 1);
});

function shellEvent(
	overrides: Partial<ShellLifecycleEvent> = {},
): ShellLifecycleEvent {
	return {
		type: "shell_lifecycle",
		kind: "shell.started",
		shellId: "a1b2c3d4",
		ownerSessionId: "session-a",
		callId: "call-shell-1",
		sequence: 1,
		commandPreview: "npm test",
		background: true,
		processState: "running_background",
		transport: "pipe",
		tty: false,
		yielded: true,
		...overrides,
	};
}

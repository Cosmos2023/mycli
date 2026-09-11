import assert from "node:assert/strict";
import test from "node:test";
import type { ShellLifecycleEvent } from "@mycli/core";
import type { SessionGenerationContext } from "@mycli/runtime";
import type { ShellSessionSnapshot } from "@mycli/tools";
import { NodeGatewayShellController } from "../src/node-runtime/node-gateway-shell-controller.ts";

test("shell controller scopes snapshots and lifecycle events to the active session", () => {
	let context: SessionGenerationContext = Object.freeze({ sessionId: "session-a", generation: 2 });
	const listeners = new Set<(event: ShellLifecycleEvent) => void>();
	const published: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
	const snapshots = [
		shellSnapshot({ ownerSessionId: "session-a", shellId: "shell-a" }),
		shellSnapshot({ ownerSessionId: "session-b", shellId: "shell-b" }),
	];
	const controller = new NodeGatewayShellController({
		manager: {
			list: () => snapshots,
			terminate: async (_ownerSessionId, shellId) => shellSnapshot({ shellId }),
			terminateOwner: async () => snapshots,
		},
		lifecycle: {
			subscribe: (listener) => {
				listeners.add(listener);
				return () => { listeners.delete(listener); };
			},
		},
		context: () => context,
		isClosed: () => false,
		publish: (method, params) => { published.push({ method, params }); },
	});

	assert.deepEqual(controller.activePayloads().map((item) => item.shell_id), ["shell-a"]);
	for (const listener of listeners) {
		listener(shellEvent({ ownerSessionId: "session-b", shellId: "shell-b" }));
		listener(shellEvent({ ownerSessionId: "session-a", shellId: "shell-a" }));
	}
	assert.deepEqual(published.map((event) => [event.method, event.params.shell_id]), [
		["shell.started", "shell-a"],
	]);

	context = Object.freeze({ sessionId: "session-b", generation: 3 });
	assert.deepEqual(controller.activePayloads().map((item) => item.shell_id), ["shell-b"]);
	controller.close();
	assert.equal(listeners.size, 0);
});

test("shell controller routes stop operations through the current owner", async () => {
	const terminations: string[] = [];
	const controller = new NodeGatewayShellController({
		manager: {
			list: () => [],
			terminate: async (ownerSessionId, shellId) => {
				terminations.push(`${ownerSessionId}:${shellId}`);
				return shellSnapshot({ ownerSessionId, shellId, status: "exited" });
			},
			terminateOwner: async (ownerSessionId) => {
				terminations.push(`${ownerSessionId}:all`);
				return [];
			},
		},
		context: () => ({ sessionId: "session-a", generation: 4 }),
		isClosed: () => false,
		publish: () => {},
	});

	assert.equal((await controller.stop({ shell_id: "shell-a" })).generation, 4);
	assert.equal((await controller.stopAll()).stopped, 0);
	assert.deepEqual(terminations, ["session-a:shell-a", "session-a:all"]);
});

function shellSnapshot(overrides: Partial<ShellSessionSnapshot> = {}): ShellSessionSnapshot {
	return Object.freeze({
		success: true,
		shellId: "shell-a",
		ownerSessionId: "session-a",
		callId: "call-a",
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
		commandPreview: "npm test",
		startedAt: "2026-09-04T00:00:00.000Z",
		wallTimeSeconds: 1,
		...overrides,
	});
}

function shellEvent(overrides: Partial<ShellLifecycleEvent> = {}): ShellLifecycleEvent {
	return Object.freeze({
		kind: "shell.started",
		shellId: "shell-a",
		ownerSessionId: "session-a",
		callId: "call-a",
		sequence: 1,
		commandPreview: "npm test",
		background: true,
		processState: "running_background",
		transport: "pipe",
		tty: false,
		yielded: true,
		...overrides,
		type: "shell_lifecycle",
	});
}

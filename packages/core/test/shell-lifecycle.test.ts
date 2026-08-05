import assert from "node:assert/strict";
import test from "node:test";
import type { ShellLifecycleEvent } from "../src/index.ts";

test("shell lifecycle preserves owner, call, and monotonic sequence", () => {
	const event: ShellLifecycleEvent = Object.freeze({
		type: "shell_lifecycle",
		kind: "shell.output",
		shellId: "a1b2c3d4",
		ownerSessionId: "session-a",
		callId: "call-a",
		sequence: 2,
		commandPreview: "npm test",
		background: true,
		processState: "running_background",
		transport: "pipe",
		tty: false,
		yielded: true,
		outputDelta: "ready\n",
		nextCursor: 6,
		outputChars: 6,
		omittedOutputChars: 0,
	});
	assert.equal(event.ownerSessionId, "session-a");
	assert.equal(event.callId, "call-a");
	assert.equal(event.sequence, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadFullShellOutput } from "../src/adapters/shell-output.ts";

test("loads paginated Shell output and marks persisted cursor gaps", async () => {
	const requests: Record<string, unknown>[] = [];
	const pages = [{
		chunks: [{
			sequence: 2,
			cursor_start: 0,
			cursor_end: 5,
			omitted_before: 0,
			output: "head\n",
		}],
		next_after_sequence: 2,
		available: true,
		complete: false,
		omitted_chars: 4,
		captured_chars: 10,
		output_chars: 14,
	}, {
		chunks: [{
			sequence: 3,
			cursor_start: 9,
			cursor_end: 14,
			omitted_before: 4,
			output: "tail\n",
		}],
		next_after_sequence: null,
		available: true,
		complete: false,
		omitted_chars: 4,
		captured_chars: 10,
		output_chars: 14,
	}];
	const result = await loadFullShellOutput(async (method, params) => {
		assert.equal(method, "shell.output.load");
		requests.push(params);
		return pages.shift()!;
	}, { sessionId: "session-a", shellId: "shell-a", callId: "call-a" });

	assert.match(result.output, /^head\n\n\[\.\.\. 4 earlier output characters unavailable \.\.\.\]\ntail\n$/u);
	assert.equal(result.available, true);
	assert.equal(result.complete, false);
	assert.deepEqual(requests.map((request) => request.after_sequence), [0, 2]);
});

test("reports unavailable output for legacy sessions without chunk rows", async () => {
	const result = await loadFullShellOutput(async () => ({
		chunks: [],
		next_after_sequence: null,
		available: false,
		complete: false,
		omitted_chars: 0,
		captured_chars: 0,
		output_chars: 0,
	}), { sessionId: "legacy", shellId: "missing" });

	assert.equal(result.output, "");
	assert.equal(result.available, false);
});

test("rejects a stalled or overlapping Shell output page", async () => {
	await assert.rejects(loadFullShellOutput(async () => ({
		chunks: [],
		next_after_sequence: 0,
		available: true,
		complete: false,
		omitted_chars: 1,
		captured_chars: 0,
		output_chars: 1,
	}), { sessionId: "session-a", shellId: "shell-a" }), /stalled/u);
});

test("rejects a non-progressing cursor on a non-empty page", async () => {
	await assert.rejects(loadFullShellOutput(async () => ({
		chunks: [{
			sequence: 2,
			cursor_start: 0,
			cursor_end: 4,
			omitted_before: 0,
			output: "data",
		}],
		next_after_sequence: 1,
		available: true,
		complete: false,
		omitted_chars: 0,
		captured_chars: 4,
		output_chars: 8,
	}), { sessionId: "session-a", shellId: "shell-a" }), /stalled/u);
});

test("marks incomplete output when aggregate metadata reports an unseen gap", async () => {
	const result = await loadFullShellOutput(async () => ({
		chunks: [{
			sequence: 2,
			cursor_start: 0,
			cursor_end: 4,
			omitted_before: 0,
			output: "tail",
		}],
		next_after_sequence: null,
		available: true,
		complete: false,
		omitted_chars: 6,
		captured_chars: 4,
		output_chars: 10,
	}), { sessionId: "session-a", shellId: "shell-a" });

	assert.match(result.output, /Shell output is incomplete/u);
	assert.match(result.output, /At least 6 additional characters are unavailable/u);
});

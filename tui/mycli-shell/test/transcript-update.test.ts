import assert from "node:assert/strict";
import test from "node:test";
import { initialRuntimeState, type RuntimeShellState } from "../src/adapters/runtime-state.ts";
import { classifyRuntimeTranscriptUpdate } from "../src/adapters/transcript-update.ts";

function stateWithTranscript(
	transcript: RuntimeShellState["transcript"],
): RuntimeShellState {
	return { ...initialRuntimeState(), transcript };
}

test("runtime transcript update classification recognizes unchanged and tail updates", () => {
	const first = { id: "first", type: "user", text: "hello", metadata: {} };
	const active = { id: "active", type: "assistant_stream", text: "hel", metadata: {} };
	const previous = stateWithTranscript([first, active]);

	assert.equal(classifyRuntimeTranscriptUpdate(previous, previous), "unchanged");
	assert.equal(
		classifyRuntimeTranscriptUpdate(previous, stateWithTranscript([first, active])),
		"unchanged",
	);
	assert.equal(
		classifyRuntimeTranscriptUpdate(previous, stateWithTranscript([first, { ...active, text: "hello" }])),
		"tail",
	);
	assert.equal(
		classifyRuntimeTranscriptUpdate(previous, stateWithTranscript([first, active, {
			id: "tool",
			type: "tool_summary",
			text: "Read",
			metadata: {},
		}])),
		"tail",
	);
});

test("runtime transcript update classification replaces non-tail or projection-context changes", () => {
	const first = { id: "first", type: "user", text: "hello", metadata: {} };
	const active = { id: "active", type: "assistant_stream", text: "hello", metadata: {} };
	const previous = stateWithTranscript([first, active]);

	assert.equal(
		classifyRuntimeTranscriptUpdate(previous, stateWithTranscript([{ ...first, text: "changed" }, active])),
		"replace",
	);
	assert.equal(
		classifyRuntimeTranscriptUpdate(previous, { ...previous, turnRunning: true }),
		"replace",
	);
});

test("runtime transcript update classification treats live reasoning as a tail update", () => {
	const active = { id: "active", type: "assistant_stream", text: "hello", metadata: {} };
	const previous = {
		...stateWithTranscript([active]),
		activeAssistantItemId: "active",
	};
	const next = {
		...previous,
		liveReasoning: { text: "checking", kind: "reasoning" },
	};

	assert.equal(classifyRuntimeTranscriptUpdate(previous, next), "tail");
});

test("runtime transcript update classification replaces reasoning away from the tail", () => {
	const active = { id: "active", type: "assistant_stream", text: "hello", metadata: {} };
	const tool = { id: "tool", type: "tool_summary", text: "Read", metadata: {} };
	const previous = {
		...stateWithTranscript([active, tool]),
		activeAssistantItemId: "active",
	};
	const next = {
		...previous,
		liveReasoning: { text: "checking", kind: "reasoning" },
	};

	assert.equal(classifyRuntimeTranscriptUpdate(previous, next), "replace");
});

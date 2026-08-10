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

test("validated message deltas classify an active tail without reading the stable prefix", () => {
	const transcript: RuntimeShellState["transcript"] = Array.from(
		{ length: 10_000 },
		(_, index) => ({ id: `user-${index}`, type: "user", text: `message ${index}`, metadata: {} }),
	);
	transcript.push({ id: "active", type: "assistant_stream", text: "hel", metadata: {} });
	const previous = {
		...stateWithTranscript(transcript),
		activeAssistantItemId: "active",
	};
	let indexedReads = 0;
	const nextTranscript = new Proxy(
		transcript.with(-1, { id: "active", type: "assistant_stream", text: "hello", metadata: {} }),
		{
			get(target, property, receiver) {
				if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) indexedReads += 1;
				return Reflect.get(target, property, receiver);
			},
		},
	);
	const next = { ...previous, transcript: nextTranscript };

	assert.equal(classifyRuntimeTranscriptUpdate(previous, next, "message.delta"), "tail");
	assert.ok(indexedReads <= 2, `expected tail-only reads, received ${indexedReads}`);
});

test("validated first message delta classifies an appended active tail", () => {
	const transcript: RuntimeShellState["transcript"] = Array.from(
		{ length: 10_000 },
		(_, index) => ({ id: `user-${index}`, type: "user", text: `message ${index}`, metadata: {} }),
	);
	const previous = {
		...stateWithTranscript(transcript),
		activeAssistantItemId: "active",
	};
	const next = {
		...previous,
		transcript: [
			...transcript,
			{ id: "active", type: "assistant_stream", text: "hello", metadata: {} },
		],
	};

	assert.equal(classifyRuntimeTranscriptUpdate(previous, next, "message.delta"), "tail");
});

test("message delta hint rejects non-tail active and projection context changes", () => {
	const active = { id: "active", type: "assistant_stream", text: "hel", metadata: {} };
	const tool = { id: "tool", type: "tool_summary", text: "Read", metadata: {} };
	const previous = {
		...stateWithTranscript([active, tool]),
		activeAssistantItemId: "active",
	};
	const next = {
		...previous,
		transcript: [{ ...active, text: "hello" }, tool],
	};

	assert.equal(classifyRuntimeTranscriptUpdate(previous, next, "message.delta"), "replace");
	assert.equal(
		classifyRuntimeTranscriptUpdate(previous, { ...next, turnRunning: true }, "message.delta"),
		"replace",
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

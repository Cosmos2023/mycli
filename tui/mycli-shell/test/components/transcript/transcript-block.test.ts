import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { syncTranscriptBlock } from "../../../src/components/transcript/transcript-block.ts";
import type { ProjectedTranscriptBlock } from "../../../src/transcript/transcript-projection.ts";

test("streaming assistant updates retain the component without serializing transcript blocks", () => {
	const initial: ProjectedTranscriptBlock = {
		id: "assistant-1", kind: "message",
		message: { id: "assistant-1", role: "assistant", text: "hel", thinking: "checking inputs" },
	};
	const cached = syncTranscriptBlock(initial, undefined, { hideThinking: true });
	const update: ProjectedTranscriptBlock = {
		...initial,
		message: { ...initial.message, text: "hello" },
	};
	Object.defineProperty(update, "toJSON", {
		value: () => { throw new Error("assistant updates must not serialize the transcript block"); },
	});
	const updated = syncTranscriptBlock(update, cached, { hideThinking: false });
	assert.equal(updated.component, cached.component);
	const visible = stripVTControlCharacters(updated.component.render(80).join("\n"));
	assert.match(visible, /hello/);
	assert.match(visible, /checking inputs/);
});

test("a transcript ID reused for another message role replaces its component", () => {
	const initial: ProjectedTranscriptBlock = {
		id: "message-1", kind: "message",
		message: { id: "message-1", role: "assistant", text: "previous answer" },
	};
	const cached = syncTranscriptBlock(initial, undefined, {});
	const updated = syncTranscriptBlock({
		...initial,
		message: { id: "message-1", role: "user", text: "next question" },
	}, cached, {});
	assert.notEqual(updated.component, cached.component);
	const visible = stripVTControlCharacters(updated.component.render(80).join("\n"));
	assert.match(visible, /next question/);
	assert.doesNotMatch(visible, /previous answer/);
});

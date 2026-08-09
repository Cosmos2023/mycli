import assert from "node:assert/strict";
import test from "node:test";
import {
	TURN_ABORTED_CONTEXT_TEXT,
	projectProviderRequest,
	turnAbortedContextItem,
} from "../src/index.ts";

test("builds a deterministic developer-visible interrupted-turn context item", () => {
	const first = turnAbortedContextItem("turn-1");
	const second = turnAbortedContextItem("turn-1");
	const other = turnAbortedContextItem("turn-2");

	assert.deepEqual(first, second);
	assert.notEqual(first.itemId, other.itemId);
	assert.equal(first.item.text, TURN_ABORTED_CONTEXT_TEXT);
	assert.equal(first.item.metadata.kind, "turn_aborted");
	assert.equal(first.item.metadata.role, "developer");
	assert.equal(first.item.metadata.cacheClass, "dynamic");
	assert.equal(first.item.metadata.scope, "transcript");
	assert.match(first.item.metadata.contentSha256, /^[a-f0-9]{64}$/u);
});

test("projects the interrupted-turn marker into the next provider request", () => {
	const marker = turnAbortedContextItem("turn-1").item;
	const request = projectProviderRequest({
		config: {
			provider: "openai",
			protocol: "responses",
			model: "test-model",
		},
		instructions: "system",
		history: [
			{ type: "user", text: "first turn" },
			marker,
			{ type: "user", text: "continue" },
		],
		tools: [],
	});

	assert.deepEqual(request.items, [
		{ type: "user", text: "first turn" },
		marker,
		{ type: "user", text: "continue" },
	]);
});

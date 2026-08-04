import assert from "node:assert/strict";
import test from "node:test";
import {
	projectTranscript,
	TRANSCRIPT_TEXT_MAX_CHARS,
} from "../src/index.ts";

test("suppresses only legacy synthetic approval-resume user rows", () => {
	const projected = projectTranscript([
		historyItem("original", "turn-original", "user_message", "change it"),
		historyItem("synthetic", "turn-approval", "user_message", "change it"),
	], [approvalRollout("turn-approval")]);

	assert.deepEqual(userTexts(projected), ["change it"]);
});

test("keeps independent repeated and queued user messages", () => {
	const projected = projectTranscript([
		historyItem("original", "turn-original", "user_message", "change it"),
		historyItem("repeated", "turn-repeated", "user_message", "change it"),
		historyItem("queued", "turn-approval", "user_message", "queued follow-up", {
			queued: true,
		}),
		historyItem("synthetic", "turn-approval", "user_message", "change it"),
	], [approvalRollout("turn-approval")]);

	assert.deepEqual(userTexts(projected), ["change it", "change it", "queued follow-up"]);
});

test("merges tool calls and results with stable ids and bounded visible metadata", () => {
	const oversized = `${"head".repeat(1_500)}${"tail".repeat(1_500)}`;
	const projected = projectTranscript([
		{
			...historyItem("call-item", "turn-1", "tool_call", "Write notes", {
				arguments: { path: "notes.txt", content: "private body" },
				provider_blob: "provider-private",
			}),
			tool_name: "Write",
			call_id: "call-1",
		},
		{
			...historyItem("result-item", "turn-1", "tool_result", "wrote notes", {
				transcript_content: oversized,
				success: true,
				provider_metadata: { response_id: "private-response" },
				file_changes: [{ path: "notes.txt", kind: "add", diff: "+hello" }],
			}),
			tool_name: "Write",
			call_id: "call-1",
		},
	], []);

	assert.equal(projected.length, 1);
	const tool = projected[0];
	assert.equal(tool?.id, "call-item");
	assert.equal(tool?.type, "tool");
	assert.equal(tool?.call_id, "call-1");
	assert.equal(tool?.status, "completed");
	assert.equal(tool?.output?.length, TRANSCRIPT_TEXT_MAX_CHARS);
	assert.match(tool?.output ?? "", /output omitted/u);
	assert.equal(tool?.truncated, true);
	assert.ok((tool?.omitted_chars ?? 0) > 0);
	assert.deepEqual(tool?.metadata?.file_changes, [
		{ path: "notes.txt", kind: "add", diff: "+hello" },
	]);
	assert.equal("provider_blob" in (tool?.metadata ?? {}), false);
	assert.equal("provider_metadata" in (tool?.metadata ?? {}), false);
	assert.equal(JSON.stringify(tool).includes("private body"), false);
});

test("projects reasoning summaries and unknown visible items without provider metadata", () => {
	const projected = projectTranscript([
		historyItem("reasoning", "turn-1", "reasoning", "Inspecting the repository", {
			provider_blob: "raw chain of thought",
			encrypted_content: "private",
		}),
		historyItem("future", "turn-1", "future_visible_event", "A future visible notice", {
			provider_payload: { secret: true },
		}),
		historyItem("internal", "turn-1", "capability", "internal provider capability"),
	], []);

	assert.deepEqual(projected.map((item) => [item.type, item.text]), [
		["reasoning_summary", "Inspecting the repository"],
		["status", "A future visible notice"],
	]);
	assert.equal(JSON.stringify(projected).includes("raw chain of thought"), false);
	assert.equal(JSON.stringify(projected).includes("internal provider capability"), false);
});

test("applies pagination after approval normalization", () => {
	const projected = projectTranscript([
		historyItem("first", "turn-1", "user_message", "first"),
		historyItem("synthetic", "turn-approval", "user_message", "synthetic"),
		historyItem("second", "turn-2", "assistant_message", "second"),
		historyItem("third", "turn-3", "warning", "third"),
	], [approvalRollout("turn-approval")], { before: 3, limit: 2 });

	assert.deepEqual(projected.map((item) => item.id), ["second", "third"]);
});

function historyItem(
	id: string,
	turnId: string,
	type: string,
	text: string,
	metadata: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
	return {
		id,
		thread_id: "s1",
		turn_id: turnId,
		type,
		text,
		tool_name: null,
		call_id: null,
		metadata,
	};
}

function approvalRollout(turnId: string): Readonly<Record<string, unknown>> {
	return {
		thread_id: "s1",
		turn_id: turnId,
		status: "completed",
		started_at: "2026-08-04T00:00:00.000Z",
		events: [{
			event_id: `${turnId}:approval`,
			kind: "turn_item",
			created_at: "2026-08-04T00:00:01.000Z",
			payload: { type: "approval_resolution" },
		}],
	};
}

function userTexts(items: readonly { readonly type: string; readonly text?: string }[]): string[] {
	return items
		.filter((item) => item.type === "user_message")
		.map((item) => item.text ?? "");
}

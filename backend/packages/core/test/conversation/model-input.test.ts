import assert from "node:assert/strict";
import test from "node:test";
import {
	effectiveModelContextEvents,
	manifestLogicalInputSha256,
	manifestTimelineLogicalInputSha256,
	modelInputSha256,
	orderInstructionFragments,
	providerTimelinePrefixSha256,
	stableModelInputJson,
	type InstructionFragment,
	type InstructionSnapshot,
	type ModelContextEvent,
	type ProviderInputTimelineEvent,
	type ToolSetSnapshot,
} from "../../src/index.ts";

test("stable model-input JSON and digest ignore object key insertion order", () => {
	const left = { b: 2, a: { d: 4, c: 3 } };
	const right = { a: { c: 3, d: 4 }, b: 2 };
	assert.equal(stableModelInputJson(left), stableModelInputJson(right));
	assert.equal(modelInputSha256(left), modelInputSha256(right));
});

test("orders instruction fragments by cache class, semantic kind, and stable identity", () => {
	const ordered = orderInstructionFragments([
		fragment("hook", "hook_context", "ephemeral"),
		fragment("workspace", "workspace_instructions", "static"),
		fragment("permissions", "permissions", "dynamic"),
		fragment("catalog", "skill_catalog", "static"),
	]);
	assert.deepEqual(ordered.map((item) => item.key), [
		"catalog",
		"workspace",
		"permissions",
		"hook",
	]);
});

test("resolves append-only supersession and tombstones without mutating prior events", () => {
	const first = event("event-1", "workspace", fragment("workspace", "workspace_instructions", "static"));
	const second = {
		...event("event-2", "workspace", fragment("workspace", "workspace_instructions", "static")),
		supersedesEventId: first.eventId,
	};
	const tombstone = {
		...event("event-3", "workspace"),
		supersedesEventId: second.eventId,
		tombstone: true,
	};

	assert.equal(effectiveModelContextEvents([first, second]).get("workspace")?.eventId, "event-2");
	assert.equal(effectiveModelContextEvents([first, second, tombstone]).has("workspace"), false);
	assert.equal(first.supersedesEventId, undefined);
	assert.throws(() => effectiveModelContextEvents([first, {
		...second,
		supersedesEventId: "missing",
	}]), /supersession/);
});

test("logical input digest covers full instruction, tool, and ordered reference snapshots", () => {
	const instructions: InstructionSnapshot = {
		snapshotId: "instructions-1",
		version: "v1",
		source: "builtin",
		content: "You are mycli.",
		contentSha256: modelInputSha256("You are mycli."),
		createdAt: "2026-08-08T00:00:00.000Z",
	};
	const tools: ToolSetSnapshot = {
		snapshotId: "tools-1",
		tools: [],
		contentSha256: modelInputSha256([]),
		createdAt: "2026-08-08T00:00:00.000Z",
	};
	const first = manifestLogicalInputSha256(instructions, tools, [{
		kind: "instruction_snapshot",
		id: instructions.snapshotId,
		role: "system",
		contentSha256: instructions.contentSha256,
	}]);
	const second = manifestLogicalInputSha256(instructions, tools, []);
	assert.match(first, /^[a-f0-9]{64}$/u);
	assert.notEqual(first, second);
});

test("compact timeline commitments change on append, order, and projected content", () => {
	const instructions = instructionSnapshot();
	const tools: ToolSetSnapshot = {
		snapshotId: "tools-1",
		tools: [],
		contentSha256: modelInputSha256([]),
		createdAt: "2026-08-08T00:00:00.000Z",
	};
	const boundary = timelineEvent("timeline-1", "window_boundary");
	const user = timelineEvent("timeline-2", "conversation_item", { type: "user", text: "one" });
	const assistant = timelineEvent(
		"timeline-3",
		"conversation_item",
		{ type: "assistant", text: "two" },
	);
	const firstPrefix = providerTimelinePrefixSha256([boundary, user]);
	const appendedPrefix = providerTimelinePrefixSha256([boundary, user, assistant]);
	const reorderedPrefix = providerTimelinePrefixSha256([boundary, assistant, user]);
	assert.match(firstPrefix, /^[a-f0-9]{64}$/u);
	assert.notEqual(firstPrefix, appendedPrefix);
	assert.notEqual(appendedPrefix, reorderedPrefix);

	const firstTimeline = modelInputSha256([user.item]);
	const appendedTimeline = modelInputSha256([user.item, assistant.item]);
	assert.notEqual(
		manifestTimelineLogicalInputSha256(instructions, tools, firstTimeline),
		manifestTimelineLogicalInputSha256(instructions, tools, appendedTimeline),
	);
});

function fragment(
	key: string,
	kind: InstructionFragment["kind"],
	cacheClass: InstructionFragment["cacheClass"],
): InstructionFragment {
	const content = `${key} content`;
	return Object.freeze({
		fragmentId: `fragment-${key}`,
		key,
		kind,
		title: key,
		content,
		contentSha256: modelInputSha256(content),
		role: kind === "permissions" || kind === "skill_catalog" ? "developer" : "user",
		source: "test",
		cacheClass,
		durability: "persistent",
		scope: "turn",
		includeInMemory: false,
		required: false,
	});
}

function event(
	eventId: string,
	sectionKey: string,
	value?: InstructionFragment,
): ModelContextEvent {
	return Object.freeze({
		eventId,
		sessionId: "session-1",
		turnId: "turn-1",
		providerStep: 1,
		sectionKey,
		...(value ? { fragment: value } : {}),
		tombstone: false,
		createdAt: "2026-08-08T00:00:00.000Z",
	});
}

function instructionSnapshot(): InstructionSnapshot {
	const content = "You are mycli.";
	return Object.freeze({
		snapshotId: "instructions-1",
		version: "v1",
		source: "builtin",
		content,
		contentSha256: modelInputSha256(content),
		createdAt: "2026-08-08T00:00:00.000Z",
	});
}

function timelineEvent(
	eventId: string,
	kind: ProviderInputTimelineEvent["kind"],
	item?: ProviderInputTimelineEvent["item"],
): ProviderInputTimelineEvent {
	const windowId = "window-1";
	return Object.freeze({
		eventId,
		sessionId: "session-1",
		windowId,
		turnId: "turn-1",
		providerStep: 1,
		kind,
		...(item ? { item } : { boundary: "bootstrap" as const }),
		contentSha256: item
			? modelInputSha256(item)
			: modelInputSha256({ window_id: windowId, boundary: "bootstrap" }),
		createdAt: "2026-08-08T00:00:00.000Z",
	});
}

import assert from "node:assert/strict";
import test from "node:test";
import {
	modelInputSha256,
	type InstructionFragment,
	type ModelContextEvent,
	type ProviderInputTimelineEvent,
	type ProviderRequestManifest,
} from "@mycli/core";
import { projectProviderInputTimeline } from "../src/provider-input-timeline.ts";

const NOW = "2026-08-09T00:00:00.000Z";

test("appends only the unsynchronized conversation tail in an existing window", () => {
	const first = bootstrap();
	const second = projectProviderInputTimeline({
		...input(),
		turnId: "turn-2",
		providerStep: 2,
		history: [
			{ type: "user", text: "U1" },
			{ type: "assistant", text: "A1" },
			{ type: "user", text: "U2" },
		],
		currentUserRequest: "U2",
		contextEvents: [],
		timelineHistory: first.timelineEvents,
		previousManifest: manifestStub(first.windowId),
	});

	assert.equal(second.boundary, undefined);
	assert.deepEqual(second.items.slice(0, first.items.length), first.items);
	assert.deepEqual(second.events.map((event) => event.item?.type), ["assistant", "user"]);
});

test("appends a changed context immediately before the next user input", () => {
	const firstContext = contextEvent("context-1", "E0");
	const first = bootstrap(firstContext);
	const replacement = contextEvent("context-2", "E1", firstContext.eventId);
	const second = projectProviderInputTimeline({
		...input(replacement),
		turnId: "turn-2",
		providerStep: 2,
		history: [
			{ type: "user", text: "U1" },
			{ type: "assistant", text: "A1" },
			{ type: "user", text: "U2" },
		],
		currentUserRequest: "U2",
		contextHistory: [firstContext, replacement],
		contextEvents: [replacement],
		timelineHistory: first.timelineEvents,
		previousManifest: manifestStub(first.windowId),
	});

	assert.deepEqual(second.items.slice(0, first.items.length), first.items);
	assert.deepEqual(second.items.slice(first.items.length).map(itemText), ["A1", "E1", "U2"]);
	assert.equal(second.events[1]?.kind, "context_update");
});

test("appends a model-visible tombstone without rewriting prior context", () => {
	const firstContext = contextEvent("context-1", "E0");
	const first = bootstrap(firstContext);
	const tombstone = Object.freeze({
		...contextEvent("context-2", "unused", firstContext.eventId),
		fragment: undefined,
		tombstone: true,
	}) as ModelContextEvent;
	const second = projectProviderInputTimeline({
		...input(),
		turnId: "turn-2",
		providerStep: 2,
		fragments: [],
		history: [
			{ type: "user", text: "U1" },
			{ type: "assistant", text: "A1" },
			{ type: "user", text: "U2" },
		],
		currentUserRequest: "U2",
		contextHistory: [firstContext, tombstone],
		contextEvents: [tombstone],
		timelineHistory: first.timelineEvents,
		previousManifest: manifestStub(first.windowId),
	});

	const inactive = second.items.at(-2);
	assert.equal(inactive?.type, "context");
	if (inactive?.type !== "context") assert.fail("missing inactive context item");
	assert.equal(inactive.metadata.tombstone, true);
	assert.match(inactive.text, /status="inactive"/u);
	assert.deepEqual(second.items.slice(0, first.items.length), first.items);
});

test("starts a compaction window when canonical source no longer extends the prior source", () => {
	const firstContext = contextEvent("context-1", "E0");
	const first = bootstrap(firstContext);
	const compacted = projectProviderInputTimeline({
		...input(firstContext),
		turnId: "turn-2",
		providerStep: 2,
		history: [
			{ type: "user", text: "[compact-summary]\nold work" },
			{ type: "user", text: "U2" },
		],
		currentUserRequest: "U2",
		contextEvents: [],
		timelineHistory: first.timelineEvents,
		previousManifest: manifestStub(first.windowId),
	});

	assert.equal(compacted.boundary, "compaction");
	assert.notEqual(compacted.windowId, first.windowId);
	assert.equal(compacted.events[0]?.kind, "window_boundary");
	assert.deepEqual(compacted.items.map(itemText), ["E0", "[compact-summary]\nold work", "U2"]);
});

test("adopts a legacy manifest through an explicit legacy bootstrap window", () => {
	const projected = projectProviderInputTimeline({
		...input(),
		previousManifest: legacyManifestStub(),
	});

	assert.equal(projected.boundary, "legacy_bootstrap");
	assert.equal(projected.events[0]?.boundary, "legacy_bootstrap");
	assert.deepEqual(projected.items.map(itemText), ["E0", "U1"]);
});

test("starts a source reset window for an incompatible non-compaction edit", () => {
	const first = bootstrap();
	const reset = projectProviderInputTimeline({
		...input(),
		turnId: "turn-2",
		providerStep: 2,
		history: [{ type: "user", text: "edited U1" }],
		currentUserRequest: "edited U1",
		contextEvents: [],
		timelineHistory: first.timelineEvents,
		previousManifest: manifestStub(first.windowId),
	});

	assert.equal(reset.boundary, "source_reset");
	assert.notEqual(reset.windowId, first.windowId);
	assert.equal(reset.events[0]?.boundary, "source_reset");
	assert.deepEqual(reset.items.map(itemText), ["E0", "edited U1"]);
});

test("keeps sibling tool results contiguous before generated context", () => {
	const first = projectProviderInputTimeline({
		...input(),
		fragments: [],
		contextHistory: [],
		contextEvents: [],
	});
	const skillContext = Object.freeze({
		type: "context" as const,
		text: "loaded skill",
		metadata: Object.freeze({
			kind: "skill_instructions" as const,
			role: "user" as const,
			cacheClass: "dynamic" as const,
			durability: "persistent" as const,
			scope: "transcript" as const,
			sourceId: "skill-test",
			contentSha256: modelInputSha256("loaded skill"),
			contentLength: 12,
		}),
	});
	const continued = projectProviderInputTimeline({
		...input(),
		turnId: "turn-1",
		providerStep: 2,
		fragments: [],
		contextHistory: [],
		contextEvents: [],
		history: [
			{ type: "user", text: "U1" },
			{
				type: "assistant_tool_calls",
				text: "",
				calls: [
					{ callId: "call-1", name: "Read", argumentsJson: "{}" },
					{ callId: "call-2", name: "Read", argumentsJson: "{}" },
				],
			},
			{ type: "tool_result", callId: "call-1", toolName: "Read", output: "one", success: true },
			skillContext,
			{ type: "tool_result", callId: "call-2", toolName: "Read", output: "two", success: true },
		],
		currentUserRequest: "U1",
		timelineHistory: first.timelineEvents,
		previousManifest: manifestStub(first.windowId),
	});

	assert.deepEqual(continued.items.slice(-4).map((item) => item.type), [
		"assistant_tool_calls",
		"tool_result",
		"tool_result",
		"context",
	]);
});

function bootstrap(event = contextEvent("context-1", "E0")) {
	return projectProviderInputTimeline(input(event));
}

function input(event = contextEvent("context-1", "E0")) {
	return {
		sessionId: "session-1",
		turnId: "turn-1",
		providerStep: 1,
		history: [{ type: "user" as const, text: "U1" }],
		currentUserRequest: "U1",
		fragments: event.fragment ? [event.fragment] : [],
		contextHistory: [event],
		contextEvents: [event],
		timelineHistory: [] as readonly ProviderInputTimelineEvent[],
		createdAt: NOW,
	};
}

function contextEvent(
	eventId: string,
	content: string,
	supersedesEventId?: string,
): ModelContextEvent {
	const fragment = contextFragment(content);
	return Object.freeze({
		eventId,
		sessionId: "session-1",
		turnId: eventId === "context-1" ? "turn-1" : "turn-2",
		providerStep: eventId === "context-1" ? 1 : 2,
		sectionKey: fragment.key,
		fragment,
		...(supersedesEventId ? { supersedesEventId } : {}),
		tombstone: false,
		createdAt: NOW,
	});
}

function contextFragment(content: string): InstructionFragment {
	return Object.freeze({
		fragmentId: `fragment-${modelInputSha256(content).slice(0, 12)}`,
		key: "environment",
		kind: "environment_context",
		title: "Environment",
		content,
		contentSha256: modelInputSha256(content),
		role: "user",
		source: "runtime",
		cacheClass: "dynamic",
		durability: "persistent",
		scope: "turn",
		includeInMemory: false,
		required: true,
	});
}

function manifestStub(windowId: string) {
	return {
		schemaVersion: 2 as const,
		requestId: "request-1",
		sessionId: "session-1",
		turnId: "turn-1",
		providerStep: 1,
		providerConfig: { provider: "openai" as const, protocol: "responses" as const, model: "test" },
		instructionSnapshotId: "instructions-1",
		toolSetSnapshotId: "tools-1",
		orderedItems: [],
		requestSignature: "sha256:request",
		logicalInputSha256: "a".repeat(64),
		contextPrefixSha256: "b".repeat(64),
		boundary: "bootstrap" as const,
		createdAt: NOW,
		timelineWindowId: windowId,
		timelineEventIds: [],
		requestConfigurationSha256: "c".repeat(64),
		bootstrapPrefixSha256: "d".repeat(64),
		timelineSha256: "e".repeat(64),
		commonPrefixItemCount: 0,
	};
}

function legacyManifestStub(): ProviderRequestManifest {
	return {
		schemaVersion: 1,
		requestId: "request-legacy",
		sessionId: "session-1",
		turnId: "turn-legacy",
		providerStep: 0,
		providerConfig: { provider: "openai", protocol: "responses", model: "test" },
		instructionSnapshotId: "instructions-legacy",
		toolSetSnapshotId: "tools-legacy",
		orderedItems: [],
		requestSignature: "sha256:legacy",
		logicalInputSha256: "a".repeat(64),
		contextPrefixSha256: "b".repeat(64),
		boundary: "bootstrap",
		createdAt: NOW,
	};
}

function itemText(item: { readonly type: string; readonly text?: string }): string {
	return item.text ?? "";
}

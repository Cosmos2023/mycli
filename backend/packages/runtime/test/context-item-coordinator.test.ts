import assert from "node:assert/strict";
import test from "node:test";
import { ContextItemCoordinator } from "../src/index.ts";

test("context item coordinator maps a validated skill artifact to durable context", () => {
	const artifact = {
		kind: "skill_instructions" as const,
		name: "review",
		text: "<loaded-skill>Review carefully.</loaded-skill>",
		sourceKind: "repo",
		contentSha256: "a".repeat(64),
		contentLength: 17,
	};
	const coordinator = new ContextItemCoordinator({
		extractArtifact: (metadata) => metadata.artifact === artifact ? artifact : undefined,
	});

	const item = coordinator.contextItemFor({
		turnId: "turn-1",
		result: {
			callId: "call-1",
			toolName: "Skill",
			success: true,
			modelOutput: "Activated skill: review",
			summary: "Activated skill: review",
			metadata: { artifact },
		},
	});

	assert.deepEqual(item, {
		itemId: "turn-1:skill:review:call-1",
		text: artifact.text,
		metadata: {
			kind: "skill_instructions",
			cacheClass: "dynamic",
			durability: "persistent",
			scope: "transcript",
			sourceId: "review",
			contentSha256: "a".repeat(64),
			contentLength: 17,
		},
	});
	assert.ok(Object.isFrozen(item));
	assert.ok(Object.isFrozen(item?.metadata));
});

test("context item coordinator ignores failed tools and malformed artifacts", () => {
	const coordinator = new ContextItemCoordinator({
		extractArtifact: () => ({
			kind: "skill_instructions",
			name: "unsafe/name",
			text: "instructions",
			sourceKind: "repo",
			contentSha256: "bad",
			contentLength: 12,
		}),
	});
	const base = {
		callId: "call-1",
		toolName: "Skill",
		modelOutput: "Activated",
		summary: "Activated",
		metadata: {},
	};

	assert.equal(coordinator.contextItemFor({
		turnId: "turn-1",
		result: { ...base, success: false },
	}), undefined);
	assert.equal(coordinator.contextItemFor({
		turnId: "turn-1",
		result: { ...base, success: true },
	}), undefined);
});

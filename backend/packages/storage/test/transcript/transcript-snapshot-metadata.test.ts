import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRequestManifestV1, ProviderRequestManifestV2, ProviderRequestManifestV3 } from "@mycli/core";
import { snapshotRequestSummary, snapshotSessionMetadata } from "../../src/index.ts";

const NOW = "2026-09-15T00:00:00.000Z";

test("snapshot summaries select session and model context without provider payloads or credentials", () => {
	const session = snapshotSessionMetadata({
		sessionId: "session-1", workspaceRoot: "/workspace", threadId: "thread-1",
		createdAt: NOW, updatedAt: NOW, lastActiveAt: NOW, status: "active",
		messageCount: 7, summaryCount: 2, title: "Inspect snapshot", latestTurnStatus: "completed",
		parentId: "parent", forkPoint: 4, leaseState: "unlocked",
	});
	assert.deepEqual(session, { thread_id: "thread-1", status: "active", summary_count: 2,
		title: "Inspect snapshot", latest_turn_status: "completed", parent_session_id: "parent", fork_point: 4 });
	assert.deepEqual(snapshotRequestSummary(manifest()), {
		request_id: "request-1", turn_id: "turn-1", provider_step: 2, created_at: NOW,
		provider: "openai", protocol: "responses", model: "gpt-test", reasoning_effort: "high",
		instruction_snapshot_id: "instructions-1", tool_set_snapshot_id: "tools-1", model_input_event_count: 7,
	});
});

test("request summaries read old manifest versions without confusing references with timeline events", () => {
	const v2: ProviderRequestManifestV2 = { ...manifest(), schemaVersion: 2,
		orderedItems: [], timelineEventIds: ["event-1", "event-2"] };
	const v1: ProviderRequestManifestV1 = { ...manifest(), schemaVersion: 1, orderedItems: [] };
	assert.equal(snapshotRequestSummary(v2).model_input_event_count, 2);
	assert.equal(snapshotRequestSummary(v1).model_input_event_count, undefined);
	for (const request of [v1, v2, manifest()]) {
		assert.doesNotMatch(JSON.stringify(snapshotRequestSummary(request)), /private-|encrypted_content|api_key/u);
	}
});

function manifest(): ProviderRequestManifestV3 {
	const providerConfig = { provider: "openai", protocol: "responses", model: "gpt-test",
		reasoningEffort: "high", api_key: "private-key", encrypted_content: "private-reasoning",
	} as const;
	return {
		schemaVersion: 3, requestId: "request-1", sessionId: "session-1", turnId: "turn-1", providerStep: 2,
		providerConfig, instructionSnapshotId: "instructions-1", toolSetSnapshotId: "tools-1", createdAt: NOW,
		requestSignature: "private-signature", logicalInputSha256: "private-input-hash", contextPrefixSha256: "private-prefix-hash",
		timelineWindowId: "window-1", timelineEventCount: 7, timelinePrefixSha256: "private-timeline-prefix",
		requestConfigurationSha256: "private-config-hash", bootstrapPrefixSha256: "private-bootstrap-hash",
		timelineSha256: "private-timeline-hash", commonPrefixItemCount: 3,
	};
}

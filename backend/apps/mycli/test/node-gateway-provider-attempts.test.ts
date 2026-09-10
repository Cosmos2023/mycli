import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayEventNotification, ProviderAttemptRecord } from "@mycli/contracts";
import { NodeGatewayEventProjector } from "../src/node-runtime/node-gateway-event-projector.ts";
import { loadGatewayProviderAttempts } from "../src/node-runtime/node-gateway-provider-attempts.ts";
import { isObserverMethod } from "../src/app-server/client-access.ts";

test("committed attempts project equally into direct, mirrored and restored gateway records", () => {
	const record = attemptRecord(1);
	const emitted: GatewayEventNotification[] = [];
	const projector = new NodeGatewayEventProjector({ clock: () => 1,
		currentOwnership: () => ({ sessionId: "session-1", turnId: "turn-1", generation: 2 }),
		write: (event) => { emitted.push(event); },
	});
	projector.emitRuntime("provider.attempt.updated", { session_id: record.sessionId, turn_id: record.turnId, record });
	const direct = emitted[0];
	const mirror = emitted[1];
	assert.equal(direct?.method, "provider.attempt.updated");
	assert.equal(mirror?.method, "runtime.event");
	if (direct?.method !== "provider.attempt.updated" || mirror?.method !== "runtime.event") assert.fail();
	assert.deepEqual(mirror.params.payload, direct.params);
	const restored = loadGatewayProviderAttempts(() => [record], { sessionId: "session-1" });
	assert.deepEqual(restored.records[0], direct.params.record);
	assert.equal(isObserverMethod("provider.attempts.load"), true);
	assert.throws(() => projector.emitRuntime("provider.attempt.updated", { session_id: "other", turn_id: record.turnId, record }));
	assert.equal(emitted.length, 2);
});

test("history pages retain newest session records and ascending request cursors", () => {
	const rows = [attemptRecord(1), attemptRecord(2), attemptRecord(3)];
	const sessionPage = loadGatewayProviderAttempts(() => rows, { sessionId: "session-1", limit: 2 });
	assert.deepEqual(sessionPage.records.map((record) => record.sequence), [2, 3]);
	assert.equal(sessionPage.has_more, true);
	assert.equal(sessionPage.next_before_event_id, rows[1]?.eventId);
	const requestPage = loadGatewayProviderAttempts(() => rows, { sessionId: "session-1", requestId: "request-1", limit: 2 });
	assert.deepEqual(requestPage.records.map((record) => record.sequence), [1, 2]);
	assert.equal(requestPage.has_more, true);
	assert.throws(() => loadGatewayProviderAttempts(() => rows, { sessionId: "session-1", requestId: "request-1", afterSequence: 1 }));
	assert.throws(() => loadGatewayProviderAttempts(() => [{ ...rows[0]!, sessionId: "other" }], { sessionId: "session-1" }));
	assert.deepEqual(loadGatewayProviderAttempts(undefined, { sessionId: "session-1" }).records, []);
});

function attemptRecord(sequence: number): ProviderAttemptRecord {
	return {
		eventId: `event-${sequence}`, attemptId: "attempt-1", retryChainId: "request-1", requestId: "request-1",
		sessionId: "session-1", turnId: "turn-1", provider: "deepseek", model: "deepseek-chat", source: "worker",
		sequence, attempt: 1, state: "started", policy: { requestMaxRetries: 2, streamMaxRetries: 2 },
		requestRetriesUsed: 0, streamRetriesUsed: 0, observedAt: "2026-09-07T08:00:00Z", committedAt: "2026-09-07T08:00:00Z",
	};
}

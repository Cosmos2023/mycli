import assert from "node:assert/strict";
import test from "node:test";
import type { StoredTurnTerminalization } from "@mycli/storage";
import { projectCommittedTurnTerminalization } from "../../src/turns/turn-terminalization.ts";

test("projects completed runtime output only from the committed turn and outbox", () => {
	const terminalization = committed({
		kind: "completed",
		result: { assistant_text: "committed answer" },
		payload: {
			phase: "completed",
			usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
		},
	});

	assert.deepEqual(projectCommittedTurnTerminalization(terminalization), {
		type: "turn_completed",
		assistantText: "committed answer",
		usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
		durationMs: 1_000,
	});
});

test("projects failed runtime output from the committed lifecycle outbox", () => {
	const terminalization = committed({
		kind: "failed",
		errorCode: "provider_error",
		result: { message: "stored failure" },
		payload: {
			phase: "failed",
			errorCode: "provider_error",
			message: "committed failure",
			additionalDetails: "safe detail",
		},
	});

	assert.deepEqual(projectCommittedTurnTerminalization(terminalization), {
		type: "turn_failed",
		code: "provider_error",
		message: "committed failure",
		additionalDetails: "safe detail",
	});
});

function committed(input: Readonly<{
	readonly kind: StoredTurnTerminalization["kind"];
	readonly errorCode?: "provider_error";
	readonly result: Readonly<Record<string, unknown>>;
	readonly payload: StoredTurnTerminalization["outbox"]["payload"];
}>): StoredTurnTerminalization {
	return Object.freeze({
		kind: input.kind,
		turn: {
			schema_version: 1 as const,
			session_id: "session-1",
			client_turn_id: "client-1",
			turn_id: "turn-1",
			request_fingerprint: `sha256:${"a".repeat(64)}`,
			status: input.kind,
			error_code: input.errorCode ?? null,
			result: input.result,
			started_at: "2026-09-04T00:00:00.000Z",
			completed_at: "2026-09-04T00:00:01.000Z",
		},
		outbox: {
			schemaVersion: 1 as const,
			sequenceNo: 2,
			sessionId: "session-1",
			eventId: `event-${input.kind}`,
			turnId: "turn-1",
			eventType: "turn_lifecycle" as const,
			modelVisible: false,
			createdAt: "2026-09-04T00:00:01.000Z",
			payload: input.payload,
		},
	});
}

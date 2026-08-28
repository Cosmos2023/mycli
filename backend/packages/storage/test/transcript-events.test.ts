import assert from "node:assert/strict";
import test from "node:test";
import {
	compareTranscriptEventOrder,
	deterministicLegacyTranscriptEventId,
	parseTranscriptEventEnvelope,
	TranscriptEventContractError,
} from "../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("parses canonical user input with durable images", () => {
	const event = parseTranscriptEventEnvelope(envelope("user_input", {
		text: "inspect this screenshot",
		clientUserMessageId: "user-1",
		source: "submit",
		images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
	}, { providerIndex: 0, modelVisible: true }));

	assert.equal(event.eventType, "user_input");
	assert.deepEqual(event.payload, {
		text: "inspect this screenshot",
		clientUserMessageId: "user-1",
		source: "submit",
		images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
	});
});

test("keeps assistant output and provider replay state in one event", () => {
	const event = parseTranscriptEventEnvelope(envelope("assistant_output", {
		text: "Done.",
		responseId: "response-1",
		providerState: {
			provider: "openai",
			value: { signature: "opaque" },
			tokenEstimate: 42,
		},
	}, { providerIndex: 1, modelVisible: true }));

	assert.equal(event.eventType, "assistant_output");
	assert.equal(event.payload.text, "Done.");
	assert.deepEqual(event.payload.providerState, {
		provider: "openai",
		value: { signature: "opaque" },
		tokenEstimate: 42,
	});
	assert.throws(() => parseTranscriptEventEnvelope(envelope("assistant_output", {
		text: "Done.",
		providerState: { provider: "openai", value: {}, tokenEstimate: -1 },
	}, { providerIndex: 1, modelVisible: true })), TranscriptEventContractError);
});

test("preserves multi-call assistant batches as one ordered canonical event", () => {
	const event = parseTranscriptEventEnvelope(envelope("assistant_tool_call_batch", {
		text: "Checking both files.",
		calls: [
			{ callId: "call-1", name: "Read", argumentsJson: "{\"path\":\"a.ts\"}" },
			{ callId: "call-2", name: "Read", argumentsJson: "{\"path\":\"b.ts\"}" },
		],
		responseId: "response-tools",
	}, { providerIndex: 2, modelVisible: true }));

	assert.equal(event.eventType, "assistant_tool_call_batch");
	assert.deepEqual(event.payload.calls.map((call) => call.callId), ["call-1", "call-2"]);
	assert.throws(
		() => parseTranscriptEventEnvelope(envelope("assistant_tool_call_batch", {
			text: "duplicate",
			calls: [
				{ callId: "same", name: "Read", argumentsJson: "{}" },
				{ callId: "same", name: "Read", argumentsJson: "{}" },
			],
		}, { providerIndex: 2, modelVisible: true })),
		(error: unknown) => invalidField(error, "payload.calls"),
	);
});

test("stores full tool output once while retaining bounded display metadata", () => {
	const output = "large tool output";
	const event = parseTranscriptEventEnvelope(envelope("tool_result", {
		result: {
			callId: "call-1",
			toolName: "Read",
			output,
			success: true,
		},
		summary: "Read completed",
		metadata: { duration_ms: 4, file_changes: [{ path: "a.ts", kind: "update" }] },
	}, { providerIndex: 3, modelVisible: true }));

	assert.equal(event.eventType, "tool_result");
	assert.equal(event.payload.result.output, output);
	assert.equal(JSON.stringify(event).split(output).length - 1, 1);
});

test("parses model-visible context with explicit cache metadata", () => {
	const event = parseTranscriptEventEnvelope(envelope("context", {
		itemId: "context-1",
		text: "workspace instructions",
		metadata: {
			kind: "workspace_instructions",
			role: "developer",
			cacheClass: "static",
			durability: "persistent",
			scope: "session",
			sourceId: "workspace-agents",
			contentSha256: "a".repeat(64),
			contentLength: 22,
		},
	}, { providerIndex: 4, modelVisible: true }));

	assert.equal(event.eventType, "context");
	assert.equal(event.payload.metadata.kind, "workspace_instructions");
});

test("parses display activity for reasoning, plans, approvals, clarifications, and shell state", () => {
	for (const [index, activityType] of ([
		"reasoning",
		"plan",
		"turn_completed",
		"approval_request",
		"approval_resolution",
		"clarification_request",
		"clarification_response",
		"shell",
		"web_search",
	] as const satisfies readonly string[]).entries()) {
		const event = parseTranscriptEventEnvelope(envelope("display_activity", {
			activityType,
			text: `${activityType} activity`,
			metadata: { ordinal: index },
		}, { sequenceNo: index + 1 }));
		assert.equal(event.modelVisible, false);
		assert.equal(event.eventType, "display_activity");
		assert.equal(event.payload.activityType, activityType);
	}
});

test("parses lifecycle, rollback, compaction, and opaque legacy events", () => {
	const lifecycle = parseTranscriptEventEnvelope(envelope("turn_lifecycle", {
		phase: "failed",
		errorCode: "provider_error",
		message: "provider request failed",
		additionalDetails: "bad api_key=private-value\n at request (file:///Users/private/app.ts:1:2)",
	}));
	assert.equal(lifecycle.eventType, "turn_lifecycle");
	assert.equal(
		lifecycle.eventType === "turn_lifecycle" ? lifecycle.payload.additionalDetails : undefined,
		"bad api_key=[REDACTED]",
	);

	const rollback = parseTranscriptEventEnvelope(envelope("rollback", {
		removedTurnIds: ["turn-2", "turn-3"],
		boundaryEventId: "event-1",
		reason: "user_requested",
	}));
	if (rollback.eventType !== "rollback") assert.fail("expected rollback event");
	assert.deepEqual(rollback.payload.removedTurnIds, ["turn-2", "turn-3"]);

	const compaction = parseTranscriptEventEnvelope(envelope("compaction", {
		windowId: "window-2",
		sourceEventId: "event-8",
		sourceProviderIndex: 8,
		replacement: [
			{ type: "user", text: "summary context" },
			{ type: "assistant", text: "continue" },
		],
		summary: "Earlier work was compacted.",
		metadata: { source: "context_overflow" },
	}));
	assert.equal(compaction.eventType, "compaction");
	assert.equal(compaction.payload.replacement.length, 2);

	const rawPayload = "{malformed";
	const opaque = parseTranscriptEventEnvelope(envelope("opaque_legacy", {
		sourceKind: "conversation_messages",
		sourceIdentity: "row-7",
		rawPayload,
		errorCode: "invalid_json",
	}));
	assert.equal(opaque.eventType, "opaque_legacy");
	assert.equal(opaque.payload.rawPayload, rawPayload);
});

test("enforces provider ordering and event type/payload agreement", () => {
	assert.throws(
		() => parseTranscriptEventEnvelope(envelope("assistant_output", { text: "missing index" }, {
			modelVisible: true,
		})),
		(error: unknown) => invalidField(error, "providerIndex"),
	);
	assert.throws(
		() => parseTranscriptEventEnvelope(envelope("assistant_output", { text: "unexpected index" }, {
			modelVisible: false,
			providerIndex: 2,
		})),
		(error: unknown) => invalidField(error, "providerIndex"),
	);
	assert.throws(
		() => parseTranscriptEventEnvelope({
			...envelope("assistant_output", { text: "wrong payload" }),
			eventType: "rollback",
		}),
		(error: unknown) => invalidField(error, "payload"),
	);
	assert.throws(
		() => parseTranscriptEventEnvelope(envelope("turn_lifecycle", {
			phase: "failed",
			errorCode: "made_up_error",
			message: "failed",
		})),
		(error: unknown) => invalidField(error, "payload.errorCode"),
	);
	assert.throws(
		() => parseTranscriptEventEnvelope(envelope("turn_lifecycle", {
			phase: "failed",
			errorCode: "provider_error",
			message: "provider request failed",
			additionalDetails: "x".repeat(1_001),
		})),
		(error: unknown) => invalidField(error, "payload.additionalDetails"),
	);
});

test("uses deterministic legacy identities and total event ordering", () => {
	const identity = deterministicLegacyTranscriptEventId({
		sessionId: "session-1",
		sourceKind: "history_items",
		sourceIdentity: "sequence:42",
	});
	assert.equal(identity, deterministicLegacyTranscriptEventId({
		sessionId: "session-1",
		sourceKind: "history_items",
		sourceIdentity: "sequence:42",
	}));
	assert.notEqual(identity, deterministicLegacyTranscriptEventId({
		sessionId: "session-1",
		sourceKind: "history_items",
		sourceIdentity: "sequence:43",
	}));

	const events = [
		envelope("turn_lifecycle", { phase: "started" }, { sequenceNo: 3, eventId: "b" }),
		envelope("turn_lifecycle", { phase: "started" }, { sequenceNo: 1, eventId: "c" }),
		envelope("turn_lifecycle", { phase: "started" }, { sequenceNo: 3, eventId: "a" }),
	].map(parseTranscriptEventEnvelope).sort(compareTranscriptEventOrder);
	assert.deepEqual(events.map((event) => [event.sequenceNo, event.eventId]), [
		[1, "c"],
		[3, "a"],
		[3, "b"],
	]);
});

test("reports only stable field names for invalid or non-JSON event data", () => {
	const secret = "private-payload-secret";
	assert.throws(
		() => parseTranscriptEventEnvelope(envelope("display_activity", {
			activityType: "warning",
			metadata: { nested: { secret, invalid: undefined } },
		})),
		(error: unknown) => error instanceof TranscriptEventContractError
			&& error.field === "payload.metadata"
			&& !error.message.includes(secret),
	);
});

function envelope(
	eventType: string,
	payload: Readonly<Record<string, unknown>>,
	overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
	return {
		schemaVersion: 1,
		sequenceNo: 1,
		sessionId: "session-1",
		eventId: "event-1",
		turnId: "turn-1",
		eventType,
		modelVisible: false,
		createdAt: NOW,
		payload,
		...overrides,
	};
}

function invalidField(error: unknown, field: string): boolean {
	return error instanceof TranscriptEventContractError && error.field === field;
}

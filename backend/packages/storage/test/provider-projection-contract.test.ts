import {
	canonicalConversationItem,
	repairTerminalToolProtocol,
} from "../src/legacy-provider-projection.ts";
import {
	parseTranscriptEventEnvelope,
	projectTranscriptEventsToProviderItems,
} from "../src/index.ts";
import {
	providerProjectionContractSuite,
	type ProviderProjectionContractAdapter,
	type ProviderProjectionFixture,
} from "./provider-projection-contract-suite.ts";

providerProjectionContractSuite(legacyAdapter());
providerProjectionContractSuite(eventAdapter());

function legacyAdapter(): ProviderProjectionContractAdapter {
	return {
		name: "v9 legacy provider projector",
		project: (fixture) => repairTerminalToolProtocol(legacyRows(fixture).map((row) => (
			canonicalConversationItem(JSON.stringify(row), "conversation_messages")
		)), new Set()),
		projectTerminal: (active) => repairTerminalToolProtocol([
			canonicalConversationItem(JSON.stringify(legacyToolBatch()), "conversation_messages"),
		], active ? new Set(["call-missing"]) : new Set()),
		projectOpaque: () => [
			canonicalConversationItem("private-opaque-payload", "conversation_messages"),
		],
	};
}

function eventAdapter(): ProviderProjectionContractAdapter {
	return {
		name: "v10 transcript event projector",
		project: (fixture) => projectTranscriptEventsToProviderItems(eventRows(fixture)),
		projectTerminal: (active) => projectTranscriptEventsToProviderItems([
			eventEnvelope(1, 0, "assistant_tool_call_batch", legacyToolBatchPayload()),
		], { activeToolCallIds: active ? new Set(["call-missing"]) : new Set() }),
		projectOpaque: () => projectTranscriptEventsToProviderItems([
			eventEnvelope(1, 0, "opaque_legacy", {
				sourceKind: "conversation_messages",
				sourceIdentity: "row-private",
				rawPayload: "private-opaque-payload",
				errorCode: "invalid_json",
			}),
		]),
	};
}

function legacyRows(fixture: ProviderProjectionFixture): readonly Readonly<Record<string, unknown>>[] {
	return [
		{
			role: "user",
			content: "inspect both files",
			blocks: [{ type: "image", media_type: "image/png", data: "aW1hZ2U=" }],
		},
		{
			role: "assistant",
			content: "I will inspect them.",
			metadata: { provider_state: fixture.providerState },
		},
		{
			role: "assistant",
			content: "Reading both.",
			response_id: "response-tools",
			metadata: { provider_state: fixture.providerState },
			tool_calls: [
				{ call_id: "call-a", name: "Read", arguments: { path: "a.ts" } },
				{ call_id: "call-b", name: "Read", arguments: { path: "b.ts" } },
			],
		},
		legacyToolResult("call-a", "a"),
		legacyToolResult("call-b", "b"),
		{
			role: "context",
			content: "activated capability",
			metadata: {
				context: {
					kind: fixture.contextMetadata.kind,
					role: fixture.contextMetadata.role,
					cache_class: fixture.contextMetadata.cacheClass,
					durability: fixture.contextMetadata.durability,
					scope: fixture.contextMetadata.scope,
					source_id: fixture.contextMetadata.sourceId,
					content_sha256: fixture.contextMetadata.contentSha256,
					content_length: fixture.contextMetadata.contentLength,
				},
			},
		},
	];
}

function eventRows(fixture: ProviderProjectionFixture) {
	return [
		eventEnvelope(1, 0, "user_input", {
			text: "inspect both files",
			clientUserMessageId: "user-1",
			source: "submit",
			images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
		}),
		eventEnvelope(2, 1, "assistant_output", {
			text: "I will inspect them.",
			providerState: fixture.providerState,
		}),
		eventEnvelope(3, 2, "assistant_tool_call_batch", {
			text: "Reading both.",
			calls: [
				{ callId: "call-a", name: "Read", argumentsJson: "{\"path\":\"a.ts\"}" },
				{ callId: "call-b", name: "Read", argumentsJson: "{\"path\":\"b.ts\"}" },
			],
			responseId: "response-tools",
			providerState: fixture.providerState,
		}),
		eventEnvelope(4, 3, "tool_result", {
			result: { callId: "call-a", toolName: "Read", output: "a", success: true },
			summary: "Read a",
		}),
		eventEnvelope(5, 4, "tool_result", {
			result: { callId: "call-b", toolName: "Read", output: "b", success: true },
			summary: "Read b",
		}),
		eventEnvelope(6, 5, "context", {
			itemId: "context-1",
			text: "activated capability",
			metadata: fixture.contextMetadata,
		}),
	];
}

function eventEnvelope(
	sequenceNo: number,
	providerIndex: number,
	eventType: string,
	payload: Readonly<Record<string, unknown>>,
) {
	return parseTranscriptEventEnvelope({
		schemaVersion: 1,
		sequenceNo,
		sessionId: "session-1",
		eventId: `event-${sequenceNo}`,
		turnId: "turn-1",
		eventType,
		providerIndex,
		modelVisible: true,
		createdAt: "2026-08-14T00:00:00.000Z",
		payload,
	});
}

function legacyToolBatch(): Readonly<Record<string, unknown>> {
	return {
		role: "assistant",
		content: "",
		tool_calls: [{ call_id: "call-missing", name: "Read", arguments: {} }],
	};
}

function legacyToolBatchPayload(): Readonly<Record<string, unknown>> {
	return {
		text: "",
		calls: [{ callId: "call-missing", name: "Read", argumentsJson: "{}" }],
	};
}

function legacyToolResult(callId: string, output: string): Readonly<Record<string, unknown>> {
	return {
		role: "tool",
		content: output,
		tool_call_id: callId,
		metadata: { tool_name: "Read", success: true },
	};
}

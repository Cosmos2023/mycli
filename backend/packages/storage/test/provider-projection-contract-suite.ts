import assert from "node:assert/strict";
import test from "node:test";
import type {
	CanonicalContextMetadata,
	CanonicalConversationItem,
	ProviderReplayState,
} from "@mycli/core";
import { StorageFailure } from "../src/index.ts";

export interface ProviderProjectionFixture {
	readonly protocol: "responses" | "chat_completions";
	readonly providerState: ProviderReplayState;
	readonly contextMetadata: CanonicalContextMetadata;
}

export interface ProviderProjectionContractAdapter {
	readonly name: string;
	project(fixture: ProviderProjectionFixture): readonly CanonicalConversationItem[];
	projectTerminal(active: boolean): readonly CanonicalConversationItem[];
	projectOpaque(): readonly CanonicalConversationItem[];
}

export function providerProjectionContractSuite(
	adapter: ProviderProjectionContractAdapter,
): void {
	for (const protocol of ["responses", "chat_completions"] as const) {
		test(`${adapter.name} preserves ${protocol} images, assistant text, multi-call groups, results, context, and state`, () => {
			const fixture = projectionFixture(protocol);
			assert.deepEqual(adapter.project(fixture), expectedProjection(fixture));
		});
	}

	test(`${adapter.name} repairs only terminal missing tool results`, () => {
		const terminal = adapter.projectTerminal(false);
		assert.deepEqual(terminal.map((item) => item.type), [
			"assistant_tool_calls",
			"tool_result",
		]);
		assert.equal(terminal[1]?.type === "tool_result" && terminal[1].success, false);
		assert.deepEqual(adapter.projectTerminal(true).map((item) => item.type), [
			"assistant_tool_calls",
		]);
	});

	test(`${adapter.name} preserves opaque provider failure parity without payload exposure`, () => {
		assert.throws(
			() => adapter.projectOpaque(),
			(error: unknown) => error instanceof StorageFailure
				&& error.code === "persistence_error"
				&& !error.message.includes("private-opaque-payload"),
		);
	});
}

function projectionFixture(
	protocol: ProviderProjectionFixture["protocol"],
): ProviderProjectionFixture {
	return {
		protocol,
		providerState: {
			provider: protocol === "responses" ? "openai" : "compatible",
			value: protocol === "responses"
				? { response_signature: "opaque-responses-state" }
				: { conversation_marker: "opaque-chat-state" },
		},
		contextMetadata: {
			kind: "skill_instructions",
			role: "developer",
			cacheClass: "dynamic",
			durability: "persistent",
			scope: "transcript",
			sourceId: "projection-contract",
			contentSha256: "a".repeat(64),
			contentLength: 19,
		},
	};
}

function expectedProjection(
	fixture: ProviderProjectionFixture,
): readonly CanonicalConversationItem[] {
	return [
		{
			type: "user",
			text: "inspect both files",
			images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
		},
		{
			type: "assistant",
			text: "I will inspect them.",
			providerState: fixture.providerState,
		},
		{
			type: "assistant_tool_calls",
			text: "Reading both.",
			calls: [
				{ callId: "call-a", name: "Read", argumentsJson: "{\"path\":\"a.ts\"}" },
				{ callId: "call-b", name: "Read", argumentsJson: "{\"path\":\"b.ts\"}" },
			],
			responseId: "response-tools",
			providerState: fixture.providerState,
		},
		{ type: "tool_result", callId: "call-a", toolName: "Read", output: "a", success: true },
		{ type: "tool_result", callId: "call-b", toolName: "Read", output: "b", success: true },
		{ type: "context", text: "activated capability", metadata: fixture.contextMetadata },
	];
}

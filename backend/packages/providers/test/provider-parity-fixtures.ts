import type {
	CanonicalContextMetadata,
	ProviderId,
	ProviderRequest,
	ProtocolId,
	ReasoningEffort,
} from "@mycli/core";

export const PARITY_REASONING_EFFORTS = Object.freeze<readonly ReasoningEffort[]>([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);

export const PARITY_READ_TOOL = Object.freeze({
	id: "builtin:Read",
	name: "Read",
	description: "Read a file.",
	inputSchema: Object.freeze({
		type: "object",
		properties: Object.freeze({ file_path: Object.freeze({ type: "string" }) }),
		required: Object.freeze(["file_path"]),
	}),
});

export function parityRequest(
	provider: ProviderId,
	protocol: ProtocolId,
): ProviderRequest {
	return {
		provider,
		protocol,
		model: provider === "deepseek" ? "deepseek-reasoner" : `${provider}-test`,
		reasoningEffort: "high",
		instructions: "stable system policy",
		developerInstructions: ["stable developer policy"],
		messages: [],
		items: [
			contextItem("dynamic developer policy", "developer"),
			contextItem("ordinary context", "user"),
			{
				type: "user",
				text: "inspect",
				images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
			},
		],
		tools: [PARITY_READ_TOOL],
		maxOutputTokens: 12_000,
		sessionId: "parity-session",
		cacheRetention: "long",
	};
}

export function contextItem(
	text: string,
	role: "developer" | "user",
): Extract<ProviderRequest["items"], readonly unknown[]>[number] {
	const metadata: CanonicalContextMetadata = {
		kind: "hook_context",
		role,
		cacheClass: "ephemeral",
		durability: "persistent",
		scope: "turn",
		sourceId: `parity-${role}`,
		contentSha256: "a".repeat(64),
		contentLength: text.length,
	};
	return { type: "context", text, metadata };
}

import type {
	CanonicalMessage,
	ProviderRequest,
	ProviderRequestConfig,
} from "./types.ts";

export interface NoToolRequestProjectionInput {
	readonly config: ProviderRequestConfig;
	readonly instructions: string;
	readonly history: readonly CanonicalMessage[];
	readonly userText: string;
}

export function projectNoToolRequest(input: NoToolRequestProjectionInput): ProviderRequest {
	const messages = [
		...input.history.map((message) => ({
			role: message.role,
			content: message.content,
		})),
		{ role: "user" as const, content: input.userText },
	];
	return Object.freeze({
		...input.config,
		instructions: input.instructions,
		messages: Object.freeze(messages),
		tools: Object.freeze([]) as readonly [],
	});
}

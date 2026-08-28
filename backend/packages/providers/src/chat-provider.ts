import type {
	CanonicalConversationItem,
	CanonicalImage,
	ProviderEvent,
	ProviderReplayState,
	ProviderRequest,
	ProviderUsage,
	ToolDefinition,
} from "@mycli/core";
import {
	classifyProviderError,
	ProviderFailure,
} from "./errors.ts";
import type {
	ChatCompletionsClient,
	ModelProvider,
	ProviderStreamOptions,
} from "./model-provider.ts";
import { imageDataUrl } from "./image-data-url.ts";

export interface ChatProviderOptions {
	readonly client: ChatCompletionsClient;
	readonly developerInstructionMode?: "native" | "merge_into_system";
	readonly providerAdapter?: "default" | "deepseek";
}

interface BufferedToolCall {
	id?: string;
	name: string;
	argumentsJson: string;
}

export class ChatProvider implements ModelProvider {
	readonly #client: ChatCompletionsClient;
	readonly #developerInstructionMode: "native" | "merge_into_system";
	readonly #providerAdapter: "default" | "deepseek";

	constructor(options: ChatProviderOptions) {
		this.#client = options.client;
		this.#providerAdapter = options.providerAdapter ?? "default";
		this.#developerInstructionMode = options.developerInstructionMode
			?? (this.#providerAdapter === "deepseek" ? "merge_into_system" : "native");
	}

	async *stream(
		request: ProviderRequest,
		options: ProviderStreamOptions,
	): AsyncIterable<ProviderEvent> {
		try {
			const stream = await this.#client.create(
				requestBody(request, this.#developerInstructionMode, this.#providerAdapter),
				options,
			);
			const toolCalls = new Map<number, BufferedToolCall>();
			let reasoningContent = "";
			let responseId: string | undefined;
			let usage: ProviderUsage = {};
			let sawFinishReason = false;

			for await (const rawChunk of stream) {
				const chunk = chatChunk(rawChunk);
				if (typeof chunk.id === "string" && chunk.id) {
					responseId = chunk.id;
				}
				const chunkUsage = usageFrom(chunk.usage);
				if (Object.keys(chunkUsage).length > 0) {
					usage = chunkUsage;
				}
				for (const rawChoice of chunk.choices) {
					const choice = chatChoice(rawChoice);
					const reasoning = contentText(choice.delta.reasoning_content);
					if (reasoning) {
						reasoningContent += reasoning;
						yield { type: "reasoning_delta", text: reasoning };
					}
					const text = contentText(choice.delta.content);
					if (text) {
						yield { type: "text_delta", text };
					}
					appendToolCallFragments(choice.delta.tool_calls, toolCalls);
					if (typeof choice.finish_reason === "string" && choice.finish_reason) {
						sawFinishReason = true;
					}
				}
			}

			if (!sawFinishReason) {
				throw new ProviderFailure({
					code: "response_stream_error",
					message: "Chat stream ended without a finish reason",
					retryable: true,
				});
			}
			const completedToolCalls = toolCallEvents(toolCalls);
			if (this.#providerAdapter === "deepseek" && completedToolCalls.length > 0) {
				yield deepSeekProviderState(reasoningContent);
			}
			for (const event of completedToolCalls) {
				yield event;
			}
			if (Object.keys(usage).length > 0) {
				yield { type: "usage", usage };
			}
			yield {
				type: "completed",
				...(responseId ? { responseId } : {}),
			};
		} catch (error) {
			throw classifyProviderError(error);
		}
	}
}

function requestBody(
	request: ProviderRequest,
	developerInstructionMode: "native" | "merge_into_system",
	providerAdapter: "default" | "deepseek",
): Readonly<Record<string, unknown>> {
	return {
		model: request.model,
		messages: [
			...instructionMessages(request, developerInstructionMode),
			...(request.items
				? request.items.map((item) => chatMessage(
					item,
					developerInstructionMode,
					providerAdapter,
				))
				: request.messages.map((message) => ({
					role: message.role,
					content: message.content,
				}))),
		],
		stream: true,
		stream_options: { include_usage: true },
		temperature: 0,
		...(request.tools.length > 0
			? { tools: request.tools.map(chatTool) }
			: {}),
		...(request.maxOutputTokens === undefined
			? {}
			: { max_completion_tokens: request.maxOutputTokens }),
		...(request.store === undefined ? {} : { store: request.store }),
		...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
		...(providerAdapter === "deepseek" ? deepSeekThinkingConfig(request) : {}),
	};
}

function instructionMessages(
	request: ProviderRequest,
	developerInstructionMode: "native" | "merge_into_system",
): readonly Readonly<Record<string, string>>[] {
	const developerInstructions = request.developerInstructions ?? [];
	if (developerInstructionMode === "merge_into_system") {
		const content = [request.instructions, ...developerInstructions]
			.filter((item) => item.length > 0)
			.join("\n\n");
		return content ? [{ role: "system", content }] : [];
	}
	return [
		...(request.instructions
			? [{ role: "system", content: request.instructions }]
			: []),
		...developerInstructions.map((content) => ({ role: "developer", content })),
	];
}

function chatMessage(
	item: CanonicalConversationItem,
	developerInstructionMode: "native" | "merge_into_system",
	providerAdapter: "default" | "deepseek",
): Readonly<Record<string, unknown>> {
	switch (item.type) {
		case "user":
			return { role: "user", content: chatUserContent(item.text, item.images) };
		case "assistant":
			return { role: "assistant", content: item.text };
		case "context":
			return {
				role: chatContextRole(item.metadata.role, developerInstructionMode, providerAdapter),
				content: item.text,
			};
		case "assistant_tool_calls":
			return {
				role: "assistant",
				content: item.text,
				...(item.providerState?.provider === "deepseek"
					? { reasoning_content: deepSeekReplayContent(item.providerState) }
					: {}),
				tool_calls: item.calls.map((call) => ({
					id: call.callId,
					type: "function",
					function: { name: call.name, arguments: call.argumentsJson },
				})),
			};
		case "tool_result":
			return { role: "tool", tool_call_id: item.callId, content: item.output };
	}
}

function chatContextRole(
	role: "developer" | "user" | undefined,
	developerInstructionMode: "native" | "merge_into_system",
	providerAdapter: "default" | "deepseek",
): "developer" | "system" | "user" {
	if (role !== "developer") return "user";
	// DeepSeek folds system messages into its cache identity. Keep changing timeline context at the
	// append-only suffix; stable developer instructions remain in the initial system message.
	if (providerAdapter === "deepseek") return "user";
	return developerInstructionMode === "native" ? "developer" : "system";
}

function chatUserContent(
	text: string,
	images: readonly CanonicalImage[] | undefined,
): string | readonly Readonly<Record<string, unknown>>[] {
	if (!images || images.length === 0) return text;
	return Object.freeze([
		...(text ? [{ type: "text", text }] : []),
		...images.map((image) => ({
			type: "image_url",
			image_url: { url: imageDataUrl(image) },
		})),
	]);
}

const DEEPSEEK_SYNTHETIC_REASONING_CONTENT = "Provider omitted reasoning_content for this tool call.";
const DEEPSEEK_REASONING_CONTENT_MAX_CHARS = 60_000;

function deepSeekThinkingConfig(request: ProviderRequest): Readonly<Record<string, unknown>> {
	if (!request.reasoningEffort || request.reasoningEffort === "none") {
		return { thinking: { type: "disabled" } };
	}
	return {
		thinking: { type: "enabled" },
		reasoning_effort: request.reasoningEffort === "xhigh"
			|| request.reasoningEffort === "max"
			|| request.reasoningEffort === "ultra"
			? "max"
			: "high",
	};
}

function deepSeekProviderState(reasoningContent: string): ProviderEvent {
	const normalized = reasoningContent.trim();
	const replay = normalized
		? normalized.slice(0, DEEPSEEK_REASONING_CONTENT_MAX_CHARS)
		: DEEPSEEK_SYNTHETIC_REASONING_CONTENT;
	return {
		type: "provider_state",
		state: {
			provider: "deepseek",
			value: { reasoningContent: replay },
		},
	};
}

function deepSeekReplayContent(state: ProviderReplayState): string {
	const value = state.value.reasoningContent;
	if (typeof value !== "string" || !value.trim() || value.length > DEEPSEEK_REASONING_CONTENT_MAX_CHARS) {
		return DEEPSEEK_SYNTHETIC_REASONING_CONTENT;
	}
	return value;
}

function chatTool(tool: ToolDefinition): Readonly<Record<string, unknown>> {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
		},
	};
}

function chatChunk(value: unknown): Record<string, unknown> & { choices: readonly unknown[] } {
	if (!isRecord(value) || !Array.isArray(value.choices)) {
		throw new ProviderFailure({
			code: "provider_error",
			message: "malformed Chat stream chunk",
		});
	}
	return value as Record<string, unknown> & { choices: readonly unknown[] };
}

function chatChoice(value: unknown): {
	readonly delta: Readonly<Record<string, unknown>>;
	readonly finish_reason?: unknown;
} {
	if (!isRecord(value) || !isRecord(value.delta)) {
		throw new ProviderFailure({
			code: "provider_error",
			message: "malformed Chat stream choice",
		});
	}
	return {
		delta: value.delta,
		finish_reason: value.finish_reason,
	};
}

function contentText(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (!Array.isArray(value)) {
		throw new ProviderFailure({
			code: "provider_error",
			message: "malformed Chat content delta",
		});
	}
	return value.map((part) => {
		if (typeof part === "string") {
			return part;
		}
		if (isRecord(part) && typeof part.text === "string") {
			return part.text;
		}
		throw new ProviderFailure({
			code: "provider_error",
			message: "malformed Chat content part",
		});
	}).join("");
}

function appendToolCallFragments(
	value: unknown,
	toolCalls: Map<number, BufferedToolCall>,
): void {
	if (value === undefined || value === null) {
		return;
	}
	if (!Array.isArray(value)) {
		throw malformedToolCall();
	}
	for (const rawFragment of value) {
		if (!isRecord(rawFragment) || !Number.isInteger(rawFragment.index)) {
			throw malformedToolCall();
		}
		const index = rawFragment.index as number;
		const current = toolCalls.get(index) ?? { name: "", argumentsJson: "" };
		if (typeof rawFragment.id === "string") {
			current.id = rawFragment.id;
		}
		if (rawFragment.function !== undefined) {
			if (!isRecord(rawFragment.function)) {
				throw malformedToolCall();
			}
			if (typeof rawFragment.function.name === "string") {
				current.name += rawFragment.function.name;
			}
			if (typeof rawFragment.function.arguments === "string") {
				current.argumentsJson += rawFragment.function.arguments;
			}
		}
		toolCalls.set(index, current);
	}
}

function toolCallEvents(toolCalls: ReadonlyMap<number, BufferedToolCall>): readonly ProviderEvent[] {
	return [...toolCalls.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, call]) => {
			if (!call.name || !call.argumentsJson) {
				throw malformedToolCall();
			}
			if (!call.id) {
				throw new ProviderFailure({
					code: "tool_protocol_error",
					message: "Chat tool call is missing a call id",
				});
			}
			return {
				type: "tool_call" as const,
				callId: call.id,
				name: call.name,
				argumentsJson: call.argumentsJson,
			};
		});
}

function usageFrom(value: unknown): ProviderUsage {
	if (!isRecord(value)) {
		return {};
	}
	const usage: Record<string, number> = {};
	copyNumber(value, "prompt_tokens", "input_tokens", usage);
	copyNumber(value, "completion_tokens", "output_tokens", usage);
	copyNumber(value, "total_tokens", "total_tokens", usage);
	if (isRecord(value.prompt_tokens_details)) {
		const cached = value.prompt_tokens_details.cached_tokens;
		if (typeof cached === "number" && Number.isFinite(cached)) {
			usage.cached_tokens = cached;
		}
	}
	return usage;
}

function copyNumber(
	source: Readonly<Record<string, unknown>>,
	sourceKey: string,
	targetKey: string,
	target: Record<string, number>,
): void {
	const value = source[sourceKey];
	if (typeof value === "number" && Number.isFinite(value)) {
		target[targetKey] = value;
	}
}

function malformedToolCall(): ProviderFailure {
	return new ProviderFailure({
		code: "provider_error",
		message: "malformed Chat tool call",
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

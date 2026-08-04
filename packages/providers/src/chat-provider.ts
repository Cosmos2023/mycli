import type {
	CanonicalConversationItem,
	ProviderEvent,
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

export interface ChatProviderOptions {
	readonly client: ChatCompletionsClient;
}

interface BufferedToolCall {
	id?: string;
	name: string;
	argumentsJson: string;
}

export class ChatProvider implements ModelProvider {
	readonly #client: ChatCompletionsClient;

	constructor(options: ChatProviderOptions) {
		this.#client = options.client;
	}

	async *stream(
		request: ProviderRequest,
		options: ProviderStreamOptions,
	): AsyncIterable<ProviderEvent> {
		try {
			const stream = await this.#client.create(requestBody(request), options);
			const toolCalls = new Map<number, BufferedToolCall>();
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
					code: "provider_error",
					message: "Chat stream ended without a finish reason",
				});
			}
			for (const event of toolCallEvents(toolCalls)) {
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

function requestBody(request: ProviderRequest): Readonly<Record<string, unknown>> {
	return {
		model: request.model,
		messages: [
			...(request.instructions
				? [{ role: "system", content: request.instructions }]
				: []),
			...(request.items
				? request.items.map(chatMessage)
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
		...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
	};
}

function chatMessage(item: CanonicalConversationItem): Readonly<Record<string, unknown>> {
	switch (item.type) {
		case "user":
		case "assistant":
			return { role: item.type, content: item.text };
		case "assistant_tool_calls":
			return {
				role: "assistant",
				content: item.text,
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

function chatTool(tool: ToolDefinition): Readonly<Record<string, unknown>> {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema,
			strict: true,
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

import type {
	CanonicalConversationItem,
	CanonicalImage,
	ProviderEvent,
	ProviderReplayState,
	ProviderRequest,
	ProviderUsage,
	ToolDefinition,
} from "@mycli/core";
import { CANONICAL_IMAGE_DATA_MAX_CHARS } from "@mycli/core";
import { classifyProviderError, ProviderFailure } from "./errors.ts";
import type {
	AnthropicMessagesClient,
	ModelProvider,
	ProviderStreamOptions,
} from "./model-provider.ts";

export type { AnthropicMessagesClient } from "./model-provider.ts";

export interface AnthropicProviderOptions {
	readonly client: AnthropicMessagesClient;
}

type AnthropicRole = "user" | "assistant";
type WireBlock = Record<string, unknown>;

interface WireMessage {
	readonly role: AnthropicRole;
	readonly content: WireBlock[];
}

interface ThinkingStreamBlock {
	readonly type: "thinking";
	thinking: string;
	signature: string;
}

interface TextStreamBlock {
	readonly type: "text";
}

interface ToolStreamBlock {
	readonly type: "tool_use";
	readonly id: string;
	readonly name: string;
	readonly input: Readonly<Record<string, unknown>>;
	partialJson: string;
}

type StreamBlock = ThinkingStreamBlock | TextStreamBlock | ToolStreamBlock;

const DEFAULT_MAX_TOKENS = 8_192;
const MAX_THINKING_BLOCKS = 32;
const MAX_THINKING_CHARS = 65_536;
const MAX_SIGNATURE_CHARS = 16_384;
const CACHEABLE_BLOCK_TYPES = new Set(["text", "tool_use", "tool_result"]);
const IGNORED_EVENT_TYPES = new Set(["ping"]);
const VALID_STOP_REASONS = new Set(["end_turn", "tool_use", "stop_sequence", "pause_turn", "refusal"]);

export class AnthropicProvider implements ModelProvider {
	readonly #client: AnthropicMessagesClient;

	constructor(options: AnthropicProviderOptions) {
		this.#client = options.client;
	}

	async *stream(
		request: ProviderRequest,
		options: ProviderStreamOptions,
	): AsyncIterable<ProviderEvent> {
		try {
			assertNotAborted(options.signal);
			const stream = await this.#client.stream(requestBody(request), options);
			yield* mapStream(stream, options.signal);
		} catch (error) {
			throw classifyProviderError(error);
		}
	}
}

function requestBody(request: ProviderRequest): Readonly<Record<string, unknown>> {
	const developerContext = request.items?.flatMap((item) => (
		item.type === "context" && item.metadata.role === "developer" ? [item.text] : []
	)) ?? [];
	const messages = request.items
		? serializeItems(request.items.filter((item) => (
			item.type !== "context" || item.metadata.role !== "developer"
		)))
		: request.messages.map((message): WireMessage => ({
			role: message.role,
			content: [{ type: "text", text: message.content }],
		}));
	const instructionLayers = [
		...(request.instructions ? [request.instructions] : []),
		...(request.developerInstructions ?? []),
		...developerContext,
	];
	const system = instructionLayers.length === 0
		? undefined
		: instructionLayers.length > 1
			? instructionLayers.map((text, index) => ({
				type: "text",
				text,
				...(request.cacheControlEnabled && index === instructionLayers.length - 1
					? { cache_control: { type: "ephemeral" } }
					: {}),
			}))
			: request.cacheControlEnabled
				? [{
					type: "text",
					text: request.instructions,
					cache_control: { type: "ephemeral" },
				}]
				: request.instructions;
	if (request.cacheControlEnabled) applyMessageCacheControls(messages, 3);
	return {
		model: request.model,
		max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
		messages,
		stream: true,
		...(system === undefined ? {} : { system }),
		...(request.tools.length > 0 ? { tools: request.tools.map(serializeTool) } : {}),
		...thinkingConfig(request),
	};
}

function serializeItems(items: readonly CanonicalConversationItem[]): WireMessage[] {
	const messages: WireMessage[] = [];
	const pendingToolUses = new Set<string>();
	for (const item of items) {
		switch (item.type) {
			case "user":
				appendMessage(messages, "user", userBlocks(item.text, item.images));
				break;
			case "context":
				appendMessage(messages, "user", [{ type: "text", text: item.text }]);
				break;
			case "assistant":
				appendMessage(messages, "assistant", [
					...thinkingReplayBlocks(item.providerState),
					...(item.text ? [{ type: "text", text: item.text }] : []),
				]);
				break;
			case "assistant_tool_calls": {
				const blocks: WireBlock[] = [
					...thinkingReplayBlocks(item.providerState),
					...(item.text ? [{ type: "text", text: item.text }] : []),
				];
				for (const call of item.calls) {
					if (!call.callId || pendingToolUses.has(call.callId)) throw toolProtocolFailure();
					pendingToolUses.add(call.callId);
					blocks.push({
						type: "tool_use",
						id: call.callId,
						name: call.name,
						input: parseArguments(call.argumentsJson),
					});
				}
				appendMessage(messages, "assistant", blocks);
				break;
			}
			case "tool_result":
				if (!pendingToolUses.delete(item.callId)) {
					throw new ProviderFailure({
						code: "tool_protocol_error",
						message: "tool result has no matching Anthropic tool use",
					});
				}
				appendMessage(messages, "user", [{
					type: "tool_result",
					tool_use_id: item.callId,
					content: item.output,
					...(item.success ? {} : { is_error: true }),
				}]);
				break;
		}
	}
	return messages;
}

function userBlocks(text: string, images: readonly CanonicalImage[] | undefined): WireBlock[] {
	const blocks: WireBlock[] = text ? [{ type: "text", text }] : [];
	for (const image of images ?? []) {
		if (!image.data || image.data.length > CANONICAL_IMAGE_DATA_MAX_CHARS) {
			throw new ProviderFailure({ code: "provider_error", message: "invalid Anthropic image" });
		}
		blocks.push({
			type: "image",
			source: { type: "base64", media_type: image.mediaType, data: image.data },
		});
	}
	if (blocks.length === 0) blocks.push({ type: "text", text: "" });
	return blocks;
}

function appendMessage(messages: WireMessage[], role: AnthropicRole, blocks: WireBlock[]): void {
	if (blocks.length === 0) return;
	const previous = messages.at(-1);
	if (previous?.role === role) {
		previous.content.push(...blocks);
		return;
	}
	messages.push({ role, content: blocks });
}

function thinkingReplayBlocks(state: ProviderReplayState | undefined): WireBlock[] {
	if (!state || state.provider !== "anthropic") return [];
	const rawBlocks = state.value.thinkingBlocks;
	if (!Array.isArray(rawBlocks) || rawBlocks.length > MAX_THINKING_BLOCKS) {
		throw invalidReplayState();
	}
	return rawBlocks.map((value) => {
		const block = recordValue(value);
		const thinking = stringValue(block.thinking);
		const signature = stringValue(block.signature);
		if (!thinking || !signature
			|| thinking.length > MAX_THINKING_CHARS
			|| signature.length > MAX_SIGNATURE_CHARS) {
			throw invalidReplayState();
		}
		return { type: "thinking", thinking, signature };
	});
}

function serializeTool(tool: ToolDefinition): Readonly<Record<string, unknown>> {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.inputSchema,
	};
}

function thinkingConfig(request: ProviderRequest): Readonly<Record<string, unknown>> {
	if (!request.reasoningEffort || request.reasoningEffort === "none") return {};
	const budget = {
		minimal: 1_024,
		low: 1_024,
		medium: 1_536,
		high: 3_072,
		xhigh: 6_144,
		max: 6_144,
		ultra: 6_144,
	}[request.reasoningEffort];
	if (!budget || (request.maxOutputTokens ?? DEFAULT_MAX_TOKENS) <= budget) return {};
	return { thinking: { type: "enabled", budget_tokens: budget } };
}

function applyMessageCacheControls(messages: WireMessage[], limit: number): void {
	let remaining = limit;
	for (let index = 0; index < messages.length && remaining > 0; index += 1) {
		const block = messages[index]?.content.findLast(
			(candidate) => CACHEABLE_BLOCK_TYPES.has(String(candidate.type)),
		);
		if (!block) continue;
		block.cache_control = { type: "ephemeral" };
		remaining -= 1;
	}
}

async function* mapStream(
	stream: AsyncIterable<unknown>,
	signal: AbortSignal,
): AsyncIterable<ProviderEvent> {
	const blocks = new Map<number, StreamBlock>();
	const thinkingBlocks: Array<{ thinking: string; signature: string }> = [];
	let responseId: string | undefined;
	let usage: ProviderUsage = {};
	let stopReason: string | undefined;
	let started = false;
	let stopped = false;
	for await (const rawEvent of stream) {
		assertNotAborted(signal);
		if (stopped) throw streamFailure("Anthropic emitted an event after message_stop");
		const event = recordValue(rawEvent);
		const type = stringValue(event.type);
		if (!type) throw streamFailure("malformed Anthropic stream event");
		switch (type) {
			case "message_start": {
				if (started) throw streamFailure("duplicate Anthropic message start");
				started = true;
				const message = recordValue(event.message);
				responseId = stringValue(message.id);
				usage = mergeUsage(usage, message.usage);
				break;
			}
			case "content_block_start":
				startBlock(event, blocks);
				break;
			case "content_block_delta": {
				const deltaEvent = applyBlockDelta(event, blocks);
				if (deltaEvent) yield deltaEvent;
				break;
			}
			case "content_block_stop": {
				const stoppedBlock = stopBlock(event, blocks, thinkingBlocks);
				if (stoppedBlock) yield stoppedBlock;
				break;
			}
			case "message_delta": {
				const delta = recordValue(event.delta);
				stopReason = stringValue(delta.stop_reason) ?? stopReason;
				if (stopReason === "max_tokens") {
					throw new ProviderFailure({
						code: "provider_error",
						message: "provider output token limit reached",
					});
				}
				if (stopReason && !VALID_STOP_REASONS.has(stopReason)) {
					throw streamFailure("unsupported Anthropic stop reason");
				}
				usage = mergeUsage(usage, event.usage);
				break;
			}
			case "message_stop":
				stopped = true;
				break;
			case "error":
				throw classifyProviderError(event.error ?? event);
			default:
				if (!IGNORED_EVENT_TYPES.has(type)) {
					throw new ProviderFailure({
						code: "provider_error",
						message: "unsupported Anthropic stream event",
						diagnostics: { event_type: type.slice(0, 128) },
					});
				}
		}
	}
	assertNotAborted(signal);
	if (!started || !stopped || !stopReason || blocks.size > 0) {
		throw streamFailure("Anthropic stream ended without completion");
	}
	if (thinkingBlocks.length > 0) {
		yield {
			type: "provider_state",
			state: { provider: "anthropic", value: { thinkingBlocks } },
		};
	}
	if (Object.keys(usage).length > 0) yield { type: "usage", usage };
	yield { type: "completed", ...(responseId ? { responseId } : {}) };
}

function startBlock(event: Readonly<Record<string, unknown>>, blocks: Map<number, StreamBlock>): void {
	const index = eventIndex(event);
	if (blocks.has(index)) throw streamFailure("duplicate Anthropic content block");
	const content = recordValue(event.content_block);
	const type = stringValue(content.type);
	if (type === "thinking") {
		blocks.set(index, {
			type,
			thinking: stringValue(content.thinking) ?? "",
			signature: stringValue(content.signature) ?? "",
		});
		return;
	}
	if (type === "text") {
		blocks.set(index, { type });
		return;
	}
	if (type === "tool_use") {
		const id = stringValue(content.id);
		const name = stringValue(content.name);
		if (!id || !name) throw streamFailure("malformed Anthropic tool use");
		blocks.set(index, {
			type,
			id,
			name,
			input: recordValue(content.input),
			partialJson: "",
		});
		return;
	}
	throw streamFailure("unsupported Anthropic content block");
}

function applyBlockDelta(
	event: Readonly<Record<string, unknown>>,
	blocks: Map<number, StreamBlock>,
): ProviderEvent | undefined {
	const block = blocks.get(eventIndex(event));
	const delta = recordValue(event.delta);
	const type = stringValue(delta.type);
	if (!block || !type) throw streamFailure("malformed Anthropic content delta");
	if (type === "thinking_delta" && block.type === "thinking") {
		const thinking = stringValue(delta.thinking);
		if (thinking === undefined) throw streamFailure("malformed Anthropic thinking delta");
		block.thinking += thinking;
		if (block.thinking.length > MAX_THINKING_CHARS) throw invalidReplayState();
		return thinking ? { type: "reasoning_delta", text: thinking } : undefined;
	}
	if (type === "signature_delta" && block.type === "thinking") {
		const signature = stringValue(delta.signature);
		if (signature === undefined) throw streamFailure("malformed Anthropic signature delta");
		block.signature += signature;
		if (block.signature.length > MAX_SIGNATURE_CHARS) throw invalidReplayState();
		return undefined;
	}
	if (type === "text_delta" && block.type === "text") {
		const text = stringValue(delta.text);
		if (text === undefined) throw streamFailure("malformed Anthropic text delta");
		return text ? { type: "text_delta", text } : undefined;
	}
	if (type === "input_json_delta" && block.type === "tool_use") {
		const partialJson = stringValue(delta.partial_json);
		if (partialJson === undefined) throw streamFailure("malformed Anthropic tool input delta");
		block.partialJson += partialJson;
		return undefined;
	}
	throw streamFailure("Anthropic delta does not match content block");
}

function stopBlock(
	event: Readonly<Record<string, unknown>>,
	blocks: Map<number, StreamBlock>,
	thinkingBlocks: Array<{ thinking: string; signature: string }>,
): ProviderEvent | undefined {
	const index = eventIndex(event);
	const block = blocks.get(index);
	if (!block) throw streamFailure("unknown Anthropic content block stop");
	blocks.delete(index);
	if (block.type === "thinking") {
		if (!block.thinking || !block.signature || thinkingBlocks.length >= MAX_THINKING_BLOCKS) {
			throw invalidReplayState();
		}
		thinkingBlocks.push({ thinking: block.thinking, signature: block.signature });
		return undefined;
	}
	if (block.type === "tool_use") {
		const input = block.partialJson ? parseArguments(block.partialJson) : block.input;
		return {
			type: "tool_call",
			callId: block.id,
			name: block.name,
			argumentsJson: JSON.stringify(input),
		};
	}
	return undefined;
}

function mergeUsage(current: ProviderUsage, value: unknown): ProviderUsage {
	const raw = recordValue(value);
	const usage = { ...current } as Record<string, number>;
	for (const key of [
		"input_tokens",
		"output_tokens",
		"cache_creation_input_tokens",
		"cache_read_input_tokens",
	]) {
		const amount = raw[key];
		if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) usage[key] = amount;
	}
	return usage;
}

function parseArguments(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Readonly<Record<string, unknown>>;
		}
	} catch {
		// The stable failure below keeps raw tool arguments out of diagnostics.
	}
	throw streamFailure("invalid Anthropic tool arguments");
}

function eventIndex(event: Readonly<Record<string, unknown>>): number {
	if (typeof event.index !== "number" || !Number.isSafeInteger(event.index) || event.index < 0) {
		throw streamFailure("invalid Anthropic content block index");
	}
	return event.index;
}

function assertNotAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const error = new Error("aborted");
	error.name = "AbortError";
	throw error;
}

function invalidReplayState(): ProviderFailure {
	return new ProviderFailure({ code: "provider_error", message: "invalid Anthropic replay state" });
}

function toolProtocolFailure(): ProviderFailure {
	return new ProviderFailure({ code: "tool_protocol_error", message: "invalid Anthropic tool use" });
}

function streamFailure(message: string): ProviderFailure {
	return new ProviderFailure({ code: "provider_error", message });
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

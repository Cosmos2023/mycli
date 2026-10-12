import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Tool,
	ToolResultMessage,
	TSchema,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	CanonicalConversationItem,
	CanonicalImage,
	ProviderRequest,
} from "@mycli/core";
import { normalizeCanonicalImages, parseToolDiscoveries, toolDiscovery } from "@mycli/core";
import { canRequestOriginalImageDetail } from "@mycli/config";
import { ProviderFailure } from "../errors.ts";
import { isJsonObject } from "./json-object.ts";
import type { PiAiApi } from "./pi-ai-model.ts";
import {
	canonicalToolCallId,
	emptyPiAiUsage,
	piAiToolCall,
	restorePiAiReplay,
	type PiAiReplayTransportIdentity,
	type PiAiReplayDiagnostic,
} from "./pi-ai-replay.ts";

export interface PiAiContextProjection {
	readonly context: Context;
	readonly replayDiagnostics: readonly PiAiReplayDiagnostic[];
}

export function toPiAiContext(
	request: ProviderRequest,
	api: PiAiApi,
	transportProvider: string = request.provider,
	replayTransport?: PiAiReplayTransportIdentity,
): PiAiContextProjection {
	const messages: Message[] = [];
	const replayDiagnostics: PiAiReplayDiagnostic[] = [];
	const systemPrompt = authoritativePrompt(request);
	const toolCallIds = new Map<string, string>();
	// pi-ai 1.x carries mid-conversation tool changes as transcript system messages, so tools a
	// successful `tool_search` activated are declared where they appear instead of up front.
	const midConversationTools = midConversationToolNames(request);

	if (request.items) {
		for (const item of request.items) {
			const projected = conversationItem(
				request,
				api,
				transportProvider,
				item,
				replayDiagnostics,
				replayTransport,
			);
			if (projected?.role === "assistant") {
				for (const block of projected.content) {
					if (block.type === "toolCall") toolCallIds.set(canonicalToolCallId(block.id), block.id);
				}
			}
			if (projected?.role === "toolResult") {
				messages.push({ ...projected, toolCallId: toolCallIds.get(projected.toolCallId) ?? projected.toolCallId });
				if (item.type === "tool_result") {
					const addedTools = toolAdditionTools(request, item);
					if (addedTools.length > 0) {
						messages.push(Object.freeze({ role: "system", content: "",
							toolsAdded: [...addedTools], timestamp: 0 }));
					}
				}
			} else if (projected) messages.push(projected);
		}
	} else {
		for (const message of request.messages) {
				messages.push(userOrAssistantMessage(
					message.role,
					message.content,
					request,
					api,
					transportProvider,
				));
		}
	}

	return Object.freeze({
		context: Object.freeze({
			...(systemPrompt ? { systemPrompt } : {}),
			messages,
			...(request.tools.length > 0
				? { tools: piAiRequestTools(request).filter((tool) => !midConversationTools.has(tool.name)) }
				: {}),
		}),
		replayDiagnostics: Object.freeze(replayDiagnostics),
	});
}

function conversationItem(
	request: ProviderRequest,
	api: PiAiApi,
	transportProvider: string,
	item: CanonicalConversationItem,
	replayDiagnostics: PiAiReplayDiagnostic[],
	replayTransport?: PiAiReplayTransportIdentity,
): Message | undefined {
	switch (item.type) {
		case "user":
			return piAiUserMessage(item.text, item.images);
		case "assistant":
			return piAiAssistantMessage(
				item,
				request,
				api,
				transportProvider,
				replayDiagnostics,
				replayTransport,
			);
		case "assistant_tool_calls":
			return piAiAssistantMessage(
				item,
				request,
				api,
				transportProvider,
				replayDiagnostics,
				replayTransport,
			);
		case "tool_result":
			return Object.freeze<ToolResultMessage>({
				role: "toolResult",
				toolCallId: item.callId,
				toolName: item.toolName,
				content: [{ type: "text", text: item.output }, ...piAiImages(item.images)],
				isError: !item.success,
				timestamp: 0,
			});
		case "context":
			return item.metadata.role === "developer" ? undefined : piAiUserMessage(item.text);
	}
}

/**
 * Tools a successful `tool_search` result makes available from that point on. The transcript
 * keeps the declaration so providers with native tool additions can replay it.
 */
function toolAdditionTools(
	request: ProviderRequest,
	item: Extract<CanonicalConversationItem, { type: "tool_result" }>,
): readonly Tool[] {
	if (!item.success || item.toolName !== "tool_search") return [];
	const current = new Map(request.tools.map((tool) => [tool.id, toolDiscovery(tool)]));
	const names = parseToolDiscoveries({ version: 1, tools: item.toolDiscoveries }).flatMap((discovery) => {
		const tool = current.get(discovery.id);
		return tool?.name === discovery.name && tool.definitionSha256 === discovery.definitionSha256 ? [tool.name] : [];
	});
	if (names.length === 0) return [];
	const discovered = new Set(names);
	return piAiRequestTools(request).filter((tool) => discovered.has(tool.name));
}

/** Tool names added part-way through the transcript, which the leading declaration omits. */
function midConversationToolNames(request: ProviderRequest): ReadonlySet<string> {
	const names = new Set<string>();
	for (const item of request.items ?? []) {
		if (item.type !== "tool_result") continue;
		for (const tool of toolAdditionTools(request, item)) names.add(tool.name);
	}
	return names;
}

function piAiAssistantMessage(
	item: Extract<CanonicalConversationItem, { type: "assistant" | "assistant_tool_calls" }>,
	request: ProviderRequest,
	api: PiAiApi,
	transportProvider: string,
	replayDiagnostics: PiAiReplayDiagnostic[],
	replayTransport?: PiAiReplayTransportIdentity,
): AssistantMessage {
	const replay = restorePiAiReplay(
		item,
		api,
		request.provider,
		request.model,
		replayTransport,
	);
	if (replay.diagnostic) replayDiagnostics.push(replay.diagnostic);
	const content: AssistantMessage["content"] = [...replay.thinking];
	if (item.text) {
		content.push({
			type: "text",
			text: item.text,
			...(replay.textSignature ? { textSignature: replay.textSignature } : {}),
		});
	}
	if (item.type === "assistant_tool_calls") {
		for (const call of item.calls) {
			content.push(piAiToolCall(call.callId, call.name, call.argumentsJson, replay));
		}
	}
	return Object.freeze({
		role: "assistant",
		content,
		api,
		provider: transportProvider,
		model: request.model,
		...(replay.responseId || (item.type === "assistant_tool_calls" && item.responseId)
			? { responseId: replay.responseId ?? (item.type === "assistant_tool_calls" ? item.responseId : undefined) }
			: {}),
		...(replay.providerThinkingLevel !== undefined ? { providerThinkingLevel: replay.providerThinkingLevel } : {}),
		usage: emptyPiAiUsage(),
		stopReason: item.type === "assistant_tool_calls" ? "toolUse" : "stop",
		timestamp: 0,
	});
}

function userOrAssistantMessage(
	role: "user" | "assistant",
	content: string,
	request: ProviderRequest,
	api: PiAiApi,
	transportProvider: string,
): Message {
	if (role === "user") return piAiUserMessage(content);
	return Object.freeze({
		role: "assistant",
		content: [{ type: "text" as const, text: content }],
		api,
		provider: transportProvider,
		model: request.model,
		usage: emptyPiAiUsage(),
		stopReason: "stop",
		timestamp: 0,
	});
}

function piAiUserMessage(
	text: string,
	images?: readonly CanonicalImage[],
): UserMessage {
	if (!images || images.length === 0) {
		return Object.freeze({ role: "user", content: text, timestamp: 0 });
	}
	const content: Array<{ type: "text"; text: string } | ImageContent> = [
		...(text ? [{ type: "text" as const, text }] : []),
		...piAiImages(images),
	];
	return Object.freeze({
		role: "user",
		content,
		timestamp: 0,
	});
}

function piAiImages(images: readonly CanonicalImage[] | undefined): ImageContent[] {
	try {
		return normalizeCanonicalImages(images ?? []).map((image) => ({
			type: "image", data: image.data, mimeType: image.mediaType,
		}));
	} catch {
		throw new ProviderFailure({ code: "provider_error", message: "invalid provider images" });
	}
}

function authoritativePrompt(request: ProviderRequest): string {
	return [
		request.instructions,
		...(request.developerInstructions ?? []),
		...(request.items ?? []).flatMap((item) => item.type === "context"
			&& item.metadata.role === "developer" ? [item.text] : []),
	].filter(Boolean).join("\n\n");
}

/** Model-visible tool declarations, with the image-detail switch applied. */
function piAiRequestTools(request: ProviderRequest): Tool[] {
	return request.tools.map((tool) => {
		if (tool.name !== "view_image" || canRequestOriginalImageDetail(request)) return piAiTool(tool);
		const properties = tool.inputSchema.properties;
		return piAiTool({ ...tool, inputSchema: { ...tool.inputSchema,
			properties: isJsonObject(properties)
				? Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "detail"))
				: properties,
		} });
	});
}

function piAiTool(tool: ProviderRequest["tools"][number]): Tool {
	if (!isJsonObject(tool.inputSchema)) {
		throw new ProviderFailure({
			code: "tool_protocol_error",
			message: "tool input schema must be a JSON object",
		});
	}
	return Object.freeze({
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema as TSchema,
	});
}

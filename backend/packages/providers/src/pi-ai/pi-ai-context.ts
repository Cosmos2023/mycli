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
import { normalizeCanonicalImages } from "@mycli/core";
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
				? { tools: request.tools.map((tool) => {
					if (tool.name !== "view_image" || canRequestOriginalImageDetail(request)) return piAiTool(tool);
					const properties = tool.inputSchema.properties;
					return piAiTool({ ...tool, inputSchema: { ...tool.inputSchema,
						properties: isJsonObject(properties) ? Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "detail")) : properties,
					} });
				}) }
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

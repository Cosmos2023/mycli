import type { ServerResponse } from "node:http";

export type ResponsesSseEvent = Record<string, unknown>;

export function responsesAuthorityText(payload: Readonly<Record<string, unknown>>): string {
	if (!Array.isArray(payload.input)) return "";
	return payload.input.flatMap((item) => {
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) return [];
		return typeof item.content === "string" ? [item.content] : [];
	}).join("\n\n");
}

export function responsesTextEvents(
	text: string,
	responseId: string,
	usage: Readonly<Record<string, number>> = {},
): readonly ResponsesSseEvent[] {
	const item = {
		type: "message",
		id: `msg-${responseId}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return [
		{ type: "response.created", response: { id: responseId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				output: [item],
				usage: responsesUsage(usage),
			},
		},
	];
}

export function responsesToolEvents(
	callId: string,
	name: string,
	argumentsValue: Readonly<Record<string, unknown>>,
	responseId = `resp-${callId}`,
	usage: Readonly<Record<string, number>> = {},
): readonly ResponsesSseEvent[] {
	const argumentsJson = JSON.stringify(argumentsValue);
	const item = {
		type: "function_call",
		id: `fc-${callId}`,
		call_id: callId,
		name,
		arguments: argumentsJson,
		status: "completed",
	};
	return [
		{ type: "response.created", response: { id: responseId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, arguments: "", status: "in_progress" },
		},
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: argumentsJson },
		{
			type: "response.function_call_arguments.done",
			output_index: 0,
			arguments: argumentsJson,
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				output: [item],
				usage: responsesUsage(usage),
			},
		},
	];
}

export function writeResponsesText(
	response: ServerResponse,
	text: string,
	responseId: string,
	usage: Readonly<Record<string, number>> = {},
): void {
	writeResponsesEvents(response, responsesTextEvents(text, responseId, usage));
}

export function writeResponsesTool(
	response: ServerResponse,
	callId: string,
	name: string,
	argumentsValue: Readonly<Record<string, unknown>>,
	responseId: string,
	usage: Readonly<Record<string, number>> = {},
): void {
	writeResponsesEvents(response, responsesToolEvents(
		callId,
		name,
		argumentsValue,
		responseId,
		usage,
	));
}

export function writeResponsesEvents(
	response: ServerResponse,
	events: readonly Readonly<Record<string, unknown>>[],
): void {
	for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function responsesUsage(
	usage: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
	const inputTokens = usage.input_tokens ?? 0;
	const outputTokens = usage.output_tokens ?? 0;
	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
	};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

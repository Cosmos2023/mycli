import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { ProtocolId } from "@mycli/core";

export type MockResponseMode = "success" | "failed" | "delayed" | "truncated" | "aborted";

export interface ProviderMockRequest {
	readonly method: string;
	readonly path: string;
	readonly body: Readonly<Record<string, unknown>>;
}

export interface ProviderMockServer {
	readonly baseUrl: string;
	readonly requests: readonly ProviderMockRequest[];
	readonly abortedRequests: number;
	close(): Promise<void>;
}

export interface ProviderMockServerOptions {
	readonly protocol: ProtocolId;
	readonly mode?: MockResponseMode;
	readonly status?: number;
	readonly delayMs?: number;
	readonly errorBody?: Readonly<Record<string, unknown>>;
	readonly responseHeaders?: Readonly<Record<string, string>>;
	readonly chatScenario?: "text" | "reasoning_tool";
	readonly responsesScenario?: "text" | "web_search";
	readonly includeReasoning?: boolean;
}

export async function startProviderMockServer(
	options: ProviderMockServerOptions,
): Promise<ProviderMockServer> {
	const requests: ProviderMockRequest[] = [];
	let abortedRequests = 0;
	const server = createServer(async (request, response) => {
		try {
			const body = await requestBody(request);
			requests.push(Object.freeze({
				method: request.method ?? "",
				path: request.url ?? "",
				body,
			}));
			request.once("aborted", () => { abortedRequests += 1; });
			response.once("close", () => {
				if (!response.writableEnded) abortedRequests += 1;
			});
			await respond(response, options);
		} catch {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		get requests() { return requests; },
		get abortedRequests() { return abortedRequests; },
		close: () => closeServer(server),
	};
}

async function requestBody(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) return Object.freeze({});
	const parsed = JSON.parse(text) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new TypeError("mock provider request body must be an object");
	}
	return Object.freeze(parsed as Record<string, unknown>);
}

async function respond(
	response: ServerResponse,
	options: ProviderMockServerOptions,
): Promise<void> {
	const mode = options.mode ?? "success";
	if (mode === "failed") {
		response.writeHead(options.status ?? 429, {
			"content-type": "application/json",
			"retry-after": "1",
			"x-request-id": "req-mock",
			...options.responseHeaders,
		});
		response.end(JSON.stringify(options.errorBody
			?? { error: { type: "rate_limit_error", message: "limited" } }));
		return;
	}
	response.writeHead(200, { "content-type": "text/event-stream" });
	if (mode === "delayed") await delay(options.delayMs ?? 25);
	const frames = successFrames(options);
	if (mode === "aborted") {
		response.write(frames[0]);
		return;
	}
	if (mode === "truncated") {
		response.write(frames[0]);
		response.end();
		return;
	}
	for (const frame of frames) response.write(frame);
	response.end();
}

function successFrames(options: ProviderMockServerOptions): readonly string[] {
	switch (options.protocol) {
		case "responses": {
			const withWebSearch = options.responsesScenario === "web_search";
			const outputIndex = withWebSearch ? 1 : 0;
			const message = {
				type: "message",
				id: "msg_mock",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "OK", annotations: [] }],
			};
			const webSearch = {
				type: "web_search_call",
				id: "ws_mock",
				status: "completed",
				action: { type: "search", query: "mycli" },
			};
			return [
				sse({ type: "response.created", response: { id: "resp_mock", status: "in_progress" } }),
				...(withWebSearch ? [
					sse({ type: "keepalive" }),
					sse({
						type: "response.output_item.added",
						output_index: 0,
						item: { ...webSearch, status: "in_progress" },
					}),
					sse({
						type: "response.web_search_call.in_progress",
						output_index: 0,
						item_id: webSearch.id,
					}),
					sse({
						type: "response.web_search_call.searching",
						output_index: 0,
						item_id: webSearch.id,
					}),
					sse({
						type: "response.web_search_call.completed",
						output_index: 0,
						item_id: webSearch.id,
					}),
					sse({ type: "response.output_item.done", output_index: 0, item: webSearch }),
				] : []),
				sse({
					type: "response.output_item.added",
					output_index: outputIndex,
					item: { ...message, status: "in_progress", content: [] },
				}),
				sse({
					type: "response.output_text.delta",
					output_index: outputIndex,
					content_index: 0,
					delta: "OK",
				}),
				sse({ type: "response.output_item.done", output_index: outputIndex, item: message }),
				sse({
					type: "response.completed",
					response: {
						id: "resp_mock",
						status: "completed",
						output: [...(withWebSearch ? [webSearch] : []), message],
						usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
					},
				}),
				"data: [DONE]\n\n",
			];
		}
		case "chat_completions":
			if (options.chatScenario === "reasoning_tool") {
				return [
					...(options.includeReasoning === false ? [] : [sse({
						id: "chatcmpl_mock",
						choices: [{
							index: 0,
							delta: { reasoning_content: "checked" },
							finish_reason: null,
						}],
					})]),
					sse({
						id: "chatcmpl_mock",
						choices: [{
							index: 0,
							delta: {
								tool_calls: [{
									index: 0,
									id: "call_mock|native_item",
									type: "function",
									function: { name: "Read", arguments: "{\"file_path\":" },
								}],
							},
							finish_reason: null,
						}],
					}),
					sse({
						id: "chatcmpl_mock",
						choices: [{
							index: 0,
							delta: {
								tool_calls: [{
									index: 0,
									function: { arguments: "\"README.md\"}" },
								}],
							},
							finish_reason: null,
						}],
					}),
					sse({
						id: "chatcmpl_mock",
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						usage: {
							prompt_tokens: 9,
							completion_tokens: 4,
							total_tokens: 13,
							completion_tokens_details: { reasoning_tokens: 2 },
						},
					}),
					"data: [DONE]\n\n",
				];
			}
			return [
				sse({
					id: "chatcmpl_mock",
					choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
				}),
				sse({
					id: "chatcmpl_mock",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
				}),
				"data: [DONE]\n\n",
			];
		case "anthropic_messages":
			return [
				anthropicSse("message_start", {
					type: "message_start",
					message: {
						id: "msg_mock",
						type: "message",
						role: "assistant",
						content: [],
						model: "claude-mock",
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 4, output_tokens: 0 },
					},
				}),
				anthropicSse("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
				anthropicSse("content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "OK" },
				}),
				anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
				anthropicSse("message_delta", {
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				}),
				anthropicSse("message_stop", { type: "message_stop" }),
			];
	}
}

function sse(value: unknown): string {
	return `data: ${JSON.stringify(value)}\n\n`;
}

function anthropicSse(event: string, value: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
}

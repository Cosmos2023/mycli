import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpHttpError } from "./diagnostics.ts";

export interface LegacyHttpTransportOptions {
	readonly url: URL;
	readonly headers?: Readonly<Record<string, string>>;
	readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
	readonly maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export class LegacyHttpTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: Transport["onmessage"];
	readonly #url: URL;
	readonly #headers: Readonly<Record<string, string>>;
	readonly #fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
	readonly #maxResponseBytes: number;
	readonly #active = new Map<string | number, AbortController>();
	#started = false;
	#closed = false;

	constructor(options: LegacyHttpTransportOptions) {
		this.#url = options.url;
		this.#headers = Object.freeze({ ...options.headers });
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
		if (!Number.isSafeInteger(this.#maxResponseBytes)
			|| this.#maxResponseBytes <= 0
			|| this.#maxResponseBytes > 16_777_216) {
			throw new Error("invalid_mcp_http_response_limit");
		}
	}

	async start(): Promise<void> {
		if (this.#started) throw new Error("mcp_http_transport_started");
		if (this.#closed) throw new Error("mcp_http_transport_closed");
		this.#started = true;
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.#started || this.#closed) throw new Error("mcp_http_transport_closed");
		const cancellationId = cancelledRequestId(message);
		if (cancellationId !== undefined) this.#active.get(cancellationId)?.abort();
		const requestId = messageId(message);
		const controller = new AbortController();
		if (requestId !== undefined) this.#active.set(requestId, controller);
		try {
			const response = await this.#fetch(this.#url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...this.#headers,
				},
				body: JSON.stringify(message),
				signal: controller.signal,
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				throw new McpHttpError(response.status);
			}
			if (response.status === 202 || response.status === 204) return;
			const text = await boundedResponseText(response, this.#maxResponseBytes);
			if (!text.trim()) return;
			for (const payload of responsePayloads(response, text)) this.onmessage?.(payload);
		} catch (error) {
			if (!controller.signal.aborted) this.onerror?.(safeError(error));
			throw error;
		} finally {
			if (requestId !== undefined) this.#active.delete(requestId);
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const controller of this.#active.values()) controller.abort();
		this.#active.clear();
		this.onclose?.();
	}
}

async function boundedResponseText(response: Response, limit: number): Promise<string> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > limit) {
		await response.body?.cancel();
		throw new Error("mcp_http_response_too_large");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel();
				throw new Error("mcp_http_response_too_large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function responsePayloads(response: Response, text: string): readonly JSONRPCMessage[] {
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.includes("text/event-stream")) return normalizePayload(JSON.parse(text));
	const payloads: JSONRPCMessage[] = [];
	for (const event of text.replaceAll("\r\n", "\n").split("\n\n")) {
		const data = event.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data) payloads.push(...normalizePayload(JSON.parse(data)));
	}
	return payloads;
}

function normalizePayload(value: unknown): readonly JSONRPCMessage[] {
	const rows = Array.isArray(value) ? value : [value];
	return rows.map((row) => {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new Error("invalid_mcp_http_response");
		}
		return row as JSONRPCMessage;
	});
}

function messageId(message: JSONRPCMessage): string | number | undefined {
	return "id" in message && (typeof message.id === "string" || typeof message.id === "number")
		? message.id
		: undefined;
}

function cancelledRequestId(message: JSONRPCMessage): string | number | undefined {
	if (!("method" in message) || message.method !== "notifications/cancelled") return undefined;
	const params = "params" in message ? message.params : undefined;
	if (typeof params !== "object" || params === null || !("requestId" in params)) return undefined;
	const requestId = params.requestId;
	return typeof requestId === "string" || typeof requestId === "number" ? requestId : undefined;
}

function safeError(error: unknown): Error {
	if (error instanceof Error) return new Error(error.name || "mcp_http_error");
	return new Error("mcp_http_error");
}

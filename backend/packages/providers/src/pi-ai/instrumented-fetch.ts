import type { ProtocolId } from "@mycli/core";
import { classifyProviderError, ProviderFailure } from "../errors.ts";
import { sseStreamUntilTerminal, type SseStreamBoundaryOptions } from "./sse-stream-boundary.ts";

export interface ProviderAttemptEvidence {
	response?: {
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
	};
	transportError?: unknown;
	responseStreamFailure?: ProviderFailure;
	httpResponseFailure?: ProviderFailure;
	authFailure?: ProviderFailure;
}

const MAX_HTTP_ERROR_BYTES = 64 * 1024;

const SAFE_RESPONSE_HEADERS = Object.freeze([
	"retry-after",
	"retry-after-ms",
	"request-id",
	"x-oai-request-id",
	"x-request-id",
]);

export function instrumentedFetch(
	evidence: ProviderAttemptEvidence,
	baseFetch: typeof globalThis.fetch = globalThis.fetch,
	protocol?: ProtocolId,
	supportsFinishReason?: boolean,
	onTerminal?: () => void,
	onEvent?: SseStreamBoundaryOptions["onEvent"],
): typeof globalThis.fetch {
	return async (input, init) => {
		try {
			const response = await baseFetch(input, init);
			recordProviderResponse(evidence, response.status, response.headers);
			return observeResponseBody(response, evidence, protocol, supportsFinishReason, onTerminal, onEvent);
		} catch (error) {
			evidence.transportError = error;
			throw error;
		}
	};
}

function observeResponseBody(
	response: Response,
	evidence: ProviderAttemptEvidence,
	protocol: ProtocolId | undefined,
	supportsFinishReason: boolean | undefined,
	onTerminal: (() => void) | undefined,
	onEvent: SseStreamBoundaryOptions["onEvent"],
): Response {
	if (!response.body) return response;
	const source = protocol !== undefined && response.ok
		&& response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream"
		? sseStreamUntilTerminal(response.body, {
			protocol,
			...(supportsFinishReason === undefined ? {} : { supportsFinishReason }),
			...(onTerminal ? { onTerminal } : {}),
			...(onEvent ? { onEvent } : {}),
			onFailure(error): void {
				if (evidence.responseStreamFailure) return;
				const context = {
					source: "response_stream" as const, ...(evidence.response ? { response: evidence.response } : {}),
				};
				evidence.responseStreamFailure = error instanceof ProviderFailure
					? new ProviderFailure({ ...error, diagnostics: classifyProviderError({}, context).diagnostics })
					: classifyProviderError(error, context);
			},
		})
		: response.body;
	const reader = source.getReader();
	let cancelled = false;
	let errorBody = response.status >= 400 ? new Uint8Array(MAX_HTTP_ERROR_BYTES) : undefined;
	let errorBodyBytes = 0;
	// Observe at the SDK's pace; retain only bounded unsuccessful HTTP bodies.
	const body = new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			try {
				const result = await reader.read();
				if (cancelled) return;
				if (result.done) {
					if (errorBody && errorBodyBytes > 0) recordHttpError(evidence, errorBody.subarray(0, errorBodyBytes));
					errorBody = undefined;
					controller.close();
					reader.releaseLock();
				} else {
					if (errorBody !== undefined) {
						if (errorBodyBytes + result.value.byteLength <= MAX_HTTP_ERROR_BYTES) {
							errorBody.set(result.value, errorBodyBytes);
							errorBodyBytes += result.value.byteLength;
						} else errorBody = undefined;
					}
					controller.enqueue(result.value);
				}
			} catch (error) {
				if (cancelled) return;
				evidence.transportError = error;
				controller.error(error);
				reader.releaseLock();
			}
		},
		async cancel(reason: unknown): Promise<void> {
			cancelled = true;
			try {
				await reader.cancel(reason);
			} finally {
				reader.releaseLock();
			}
		},
	}, { highWaterMark: 0 });
	const headers = new Headers(response.headers);
	if (source !== response.body) headers.delete("content-length");
	const observed = new Response(body, {
		status: response.status, statusText: response.statusText, headers,
	});
	Object.defineProperties(observed, {
		url: { value: response.url },
		redirected: { value: response.redirected },
		type: { value: response.type },
	});
	return observed;
}

function recordHttpError(evidence: ProviderAttemptEvidence, body: Uint8Array): void {
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(body)); } catch { return; }
	if (typeof value !== "object" || value === null || Array.isArray(value)) return;
	evidence.httpResponseFailure = classifyProviderError(value, {
		source: "http", ...(evidence.response ? { response: evidence.response } : {}),
	});
}

export function recordProviderResponse(
	evidence: ProviderAttemptEvidence,
	status: number,
	headers: Headers | Readonly<Record<string, string>>,
): void {
	const safeHeaders: Record<string, string> = {};
	for (const name of SAFE_RESPONSE_HEADERS) {
		const value = headers instanceof Headers
			? headers.get(name)
			: Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
		if (typeof value === "string" && value) safeHeaders[name] = value.slice(0, 256);
	}
	evidence.response = Object.freeze({
		status,
		headers: Object.freeze(safeHeaders),
	});
}

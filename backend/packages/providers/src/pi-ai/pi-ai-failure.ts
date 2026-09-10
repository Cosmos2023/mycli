import { classifyProviderError, ProviderFailure } from "../errors.ts";
import type { ProviderAttemptEvidence } from "./instrumented-fetch.ts";

const MAX_SDK_ERROR_CHARS = 8_192;

export function piAiFailure(
	message: string | undefined,
	evidence: ProviderAttemptEvidence,
	callerSignal: AbortSignal,
	sawOutput: boolean,
): ProviderFailure {
	if (callerSignal.aborted) return interruptedFailure();
	if (evidence.authFailure) return evidence.authFailure;
	if (evidence.responseStreamFailure) return evidence.responseStreamFailure;
	if (evidence.httpResponseFailure) return evidence.httpResponseFailure;
	const response = evidence.response;
	const text = message?.slice(0, MAX_SDK_ERROR_CHARS).trim() ?? "";
	if (response && response.status >= 400) {
		const body = stripHttpEnvelope(text, response.status);
		return classifyProviderError(structuredError(body) ?? { message: plainHttpDetail(body) }, {
			source: "http", response,
		});
	}
	if (evidence.transportError !== undefined) {
		const failure = classifyProviderError(evidence.transportError, {
			source: "transport", ...(response ? { response } : {}),
		});
		if (failure.code === "interrupted") {
			return new ProviderFailure({
				...failure,
				code: sawOutput ? "response_stream_error" : "connection_error",
				errorReason: { reason: sawOutput ? "transport.stream_interrupted" : "transport.connect_failed" },
				message: "provider transport aborted without caller cancellation",
				publicDetail: "Provider connection closed before completion.",
				retryable: true,
			});
		}
		return failure.code === "connection_error" && sawOutput
			? new ProviderFailure({ ...failure, code: "response_stream_error", message: "provider response stream disconnected" })
			: failure;
	}
	if (response && response.status >= 200 && response.status < 300) {
		const remote = structuredError(text) ?? responsesErrorEnvelope(text);
		if (remote) return classifyProviderError(remote, { source: "response_stream", response });
	}
	return knownStreamFailure(text) ?? new ProviderFailure({
		code: "provider_error",
		message: "pi-ai provider request failed",
	});
}

export function classifyPiAiThrownFailure(
	error: unknown,
	evidence: ProviderAttemptEvidence,
	callerSignal: AbortSignal,
	sawOutput: boolean,
): ProviderFailure {
	if (callerSignal.aborted) return interruptedFailure();
	if (error instanceof ProviderFailure) return error;
	const message = error instanceof Error ? error.message : undefined;
	if (evidence.authFailure || evidence.responseStreamFailure || (evidence.response?.status ?? 0) >= 400 || evidence.transportError !== undefined) {
		return piAiFailure(message, evidence, callerSignal, sawOutput);
	}
	// Thrown local exceptions are not SDK terminal remote-error envelopes.
	return knownStreamFailure(message ?? "") ?? classifyProviderError(error);
}

export function interruptedFailure(): ProviderFailure {
	return new ProviderFailure({ code: "interrupted", message: "provider request interrupted" });
}

export function invalidPiAiToolArguments(): ProviderFailure {
	return new ProviderFailure({
		code: "tool_protocol_error",
		message: "pi-ai tool arguments must be a JSON object",
	});
}

function stripHttpEnvelope(text: string, status: number): string {
	const prefix = /^(?:OpenAI|Anthropic) API error \(\d{3}\):\s*/u;
	const unwrapped = text.replace(prefix, "");
	if (/^\d{3} status code \(no body\)$/iu.test(unwrapped)) return "";
	return unwrapped.replace(new RegExp(`^${status}(?:\\s+|:\\s*)`, "u"), "");
}

function plainHttpDetail(text: string): string | undefined {
	// Only a human-readable HTTP reason may fall back to text, not malformed JSON or proxy HTML.
	return /^[{[<]/u.test(text) ? undefined : text;
}

function structuredError(text: string): Readonly<Record<string, unknown>> | undefined {
	if (!text.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed)) return undefined;
		const error = isRecord(parsed.error) ? parsed.error : parsed;
		return typeof error.message === "string" || typeof error.code === "string" || typeof error.type === "string"
			? parsed : undefined;
	} catch {
		return undefined;
	}
}

function responsesErrorEnvelope(text: string): Readonly<Record<string, unknown>> | undefined {
	// These envelopes are emitted by the pinned pi-ai Responses parser, not by our TUI.
	const match = /^(?:Error Code )?([a-z][a-z0-9_]{0,127}): ([\s\S]+)$/u.exec(text);
	if (match) return { code: match[1], message: match[2] };
	if (text === "upstream request failed") return { message: text };
	if (text === "Unknown error (no error details in response)") return { code: "unknown" };
	return undefined;
}

function knownStreamFailure(text: string): ProviderFailure | undefined {
	if (/^(?:OpenAI Responses stream ended (?:before a terminal response event|without a stop reason)|(?:response )?stream ended prematurely)$/u.test(text)) {
		return new ProviderFailure({
			code: "response_stream_error",
			message: "provider response stream ended prematurely",
			publicDetail: "Response stream ended before completion.",
			retryable: true,
		});
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

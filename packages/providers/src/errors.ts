import type { RuntimeErrorCode } from "@mycli/core";

type DiagnosticValue = string | number | boolean | null;

export interface ProviderFailureOptions {
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly retryable?: boolean;
	readonly retryAfterSeconds?: number;
	readonly diagnostics?: Readonly<Record<string, DiagnosticValue>>;
}

export class ProviderFailure extends Error {
	readonly code: RuntimeErrorCode;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;
	readonly diagnostics: Readonly<Record<string, DiagnosticValue>>;

	constructor(options: ProviderFailureOptions) {
		super(`${options.code}: ${options.message}`);
		this.name = "ProviderFailure";
		this.code = options.code;
		this.retryable = options.retryable ?? false;
		this.retryAfterSeconds = options.retryAfterSeconds;
		this.diagnostics = options.diagnostics ?? {};
	}
}

export function classifyProviderError(error: unknown): ProviderFailure {
	if (error instanceof ProviderFailure) {
		return error;
	}
	const record = isRecord(error) ? error : {};
	const status = integerValue(record.status);
	const diagnostics: Record<string, DiagnosticValue> = {};
	if (status !== undefined) {
		diagnostics.status = status;
	}
	const requestId = stringValue(record.request_id) ?? stringValue(record.requestId);
	if (requestId) {
		diagnostics.request_id = requestId.slice(0, 128);
	}
	if (isAbortError(error)) {
		return new ProviderFailure({
			code: "interrupted",
			message: "provider request interrupted",
			diagnostics,
		});
	}
	const errorName = stringValue(record.name) ?? (error instanceof Error ? error.name : undefined);
	if (errorName === "APIResponseValidationError") {
		return new ProviderFailure({
			code: "provider_error",
			message: "provider response validation failed",
			diagnostics,
		});
	}
	if (status === 401 || status === 403) {
		return new ProviderFailure({
			code: "auth_error",
			message: "provider authentication failed",
			diagnostics,
		});
	}
	if (status === 429) {
		return new ProviderFailure({
			code: "rate_limited",
			message: "provider rate limit exceeded",
			retryable: true,
			retryAfterSeconds: retryAfterSeconds(record.headers),
			diagnostics,
		});
	}
	if (isContextWindowError(record)) {
		return new ProviderFailure({
			code: "context_window_exceeded",
			message: "provider context window exceeded",
			diagnostics,
		});
	}
	return new ProviderFailure({
		code: "provider_error",
		message: "provider request failed",
		retryable: status === undefined || status === 408 || (status >= 500 && status <= 599),
		diagnostics,
	});
}

function retryAfterSeconds(headers: unknown): number | undefined {
	let value: unknown;
	if (isRecord(headers)) {
		value = headers["retry-after"] ?? headers["Retry-After"];
	} else if (isRecordWithGet(headers)) {
		value = headers.get("retry-after");
	}
	const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
	return Number.isFinite(parsed) ? Math.max(0, Math.min(3600, parsed)) : undefined;
}

function isContextWindowError(error: Record<string, unknown>): boolean {
	const nested = isRecord(error.error) ? error.error : {};
	const values = [error.code, error.type, error.message, nested.code, nested.type, nested.message];
	return values.some((value) => typeof value === "string" && (
		value.toLowerCase().includes("context_window")
		|| value.toLowerCase().includes("maximum context length")
	));
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordWithGet(value: unknown): value is { get(name: string): unknown } {
	return isRecord(value) && typeof value.get === "function";
}

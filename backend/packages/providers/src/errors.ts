import {
	canonicalRuntimeFailureMessage,
	RUNTIME_RETRY_AFTER_MAX_SECONDS,
	runtimeErrorPublicMessage,
	sanitizeRuntimeErrorDetail,
} from "@mycli/contracts";
import type {
	RuntimeErrorCode,
	RuntimeFailure,
	RuntimeFailureDiagnostics,
} from "@mycli/contracts";

export interface ProviderFailureOptions {
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly publicDetail?: string;
	readonly retryable?: boolean;
	readonly retryAfterSeconds?: number;
	readonly diagnostics?: RuntimeFailureDiagnostics;
}

export class ProviderFailure extends Error {
	readonly code: RuntimeErrorCode;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;
	readonly diagnostics: RuntimeFailureDiagnostics;
	readonly publicDetail: string | undefined;

	constructor(options: ProviderFailureOptions) {
		super(`${options.code}: ${options.message}`);
		this.name = "ProviderFailure";
		this.code = options.code;
		this.retryable = options.retryable ?? false;
		this.retryAfterSeconds = boundedRetryAfterSeconds(options.retryAfterSeconds);
		this.diagnostics = options.diagnostics ?? {};
		this.publicDetail = options.publicDetail === undefined
			? undefined
			: sanitizeRuntimeErrorDetail(options.publicDetail);
	}
}

const CONNECTION_ERROR_NAMES = new Set([
	"APIConnectionError",
	"APIConnectionTimeoutError",
	"ConnectTimeoutError",
	"FetchError",
	"HeadersTimeoutError",
	"SocketError",
]);
const CONNECTION_ERROR_CODES = new Set([
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET",
]);
const OVERLOAD_ERROR_TOKENS = new Set([
	"capacity_exceeded",
	"model_overloaded",
	"overloaded_error",
	"server_overloaded",
]);
const QUOTA_ERROR_TOKENS = new Set([
	"billing_hard_limit_reached",
	"credit_balance_too_low",
	"insufficient_balance",
	"insufficient_quota",
	"quota_exceeded",
]);
const RETRYABLE_SERVER_ERROR_TOKENS = new Set([
	"internal_server_error",
	"server_error",
	"service_unavailable",
	"temporarily_unavailable",
]);

export function classifyProviderError(error: unknown): ProviderFailure {
	if (error instanceof ProviderFailure) {
		return error;
	}
	const record = isRecord(error) ? error : {};
	const status = integerValue(record.status) ?? integerValue(record.statusCode);
	const diagnostics: Record<string, string | number | boolean | null> = {};
	if (status !== undefined) {
		diagnostics.status = status;
	}
	const requestId = stringValue(record.request_id)
		?? stringValue(record.requestId)
		?? stringValue(record.requestID)
		?? requestIdFromHeaders(record.headers);
	const safeRequestId = sanitizePublicToken(requestId);
	if (safeRequestId) {
		diagnostics.request_id = safeRequestId;
	}
	const nested = isRecord(record.error) ? record.error : {};
	const nestedError = isRecord(nested.error) ? nested.error : {};
	const errorNames = providerErrorNames(error);
	const transport = transportErrorIdentity(error);
	const providerErrorCode = safeErrorToken(nested.code)
		?? safeErrorToken(record.code)
		?? safeErrorToken(nestedError.code);
	const providerErrorType = safeErrorToken(nested.type)
		?? safeErrorToken(record.type)
		?? safeErrorToken(nestedError.type);
	if (providerErrorCode && providerErrorCode.toUpperCase() !== transport.code) {
		diagnostics.provider_error_code = providerErrorCode;
	}
	if (providerErrorType) diagnostics.provider_error_type = providerErrorType;
	if (transport.code) diagnostics.transport_error_code = transport.code;
	if (transport.name) diagnostics.transport_error_name = transport.name;
	const errorTokens = providerErrorTokens(record, nested, nestedError);
	const publicDetail = extractPublicDetail(error, record, nested, {
		status,
		providerErrorCode,
		providerErrorType,
	});
	const retryAfter = retryAfterSeconds(record.headers)
		?? retryAfterSecondsFromMessage(publicDetail, errorTokens);
	if (isAbortError(error, errorNames)) {
		return new ProviderFailure({
			code: "interrupted",
			message: "provider request interrupted",
			diagnostics,
		});
	}
	if (errorNames.includes("APIResponseValidationError")) {
		return new ProviderFailure({
			code: "provider_error",
			message: "provider response validation failed",
			diagnostics,
		});
	}
	if (status === 401) {
		return new ProviderFailure({
			code: "auth_error",
			message: "provider authentication failed",
			...(publicDetail ? { publicDetail } : {}),
			diagnostics,
		});
	}
	if (status === 403) {
		return new ProviderFailure({
			code: "permission_denied",
			message: "provider access was denied",
			...(publicDetail ? { publicDetail } : {}),
			diagnostics,
		});
	}
	if (isContextWindowError(record)) {
		return new ProviderFailure({
			code: "context_window_exceeded",
			message: "provider context window exceeded",
			...(publicDetail ? { publicDetail } : {}),
			diagnostics,
		});
	}
	if (status === 402 || hasErrorToken(errorTokens, QUOTA_ERROR_TOKENS)) {
		return new ProviderFailure({
			code: "quota_exceeded",
			message: "provider quota exceeded",
			...(publicDetail ? { publicDetail } : {}),
			diagnostics,
		});
	}
	if (status === 503 || status === 529 || hasErrorToken(errorTokens, OVERLOAD_ERROR_TOKENS)) {
		return new ProviderFailure({
			code: "server_overloaded",
			message: "provider is overloaded",
			...(publicDetail ? { publicDetail } : {}),
			retryable: true,
			...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
			diagnostics,
		});
	}
	if (status === 429) {
		return new ProviderFailure({
			code: "rate_limited",
			message: "provider rate limit exceeded",
			...(publicDetail ? { publicDetail } : {}),
			retryable: true,
			...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
			diagnostics,
		});
	}
	if (status === 400 || status === 404 || status === 409
		|| status === 413 || status === 415 || status === 422) {
		return new ProviderFailure({
			code: "invalid_request",
			message: "provider rejected the request",
			...(publicDetail ? { publicDetail } : {}),
			diagnostics,
		});
	}
	if (status === 408 || transport.name !== undefined || transport.code !== undefined) {
		return new ProviderFailure({
			code: "connection_error",
			message: "provider connection failed",
			...(publicDetail ? { publicDetail } : {}),
			retryable: true,
			...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
			diagnostics,
		});
	}
	const retryable = (status !== undefined && status >= 500 && status <= 599)
		|| hasErrorToken(errorTokens, RETRYABLE_SERVER_ERROR_TOKENS)
		|| errorNames.includes("RetryableError");
	return new ProviderFailure({
		code: "provider_error",
		message: "provider request failed",
		...(publicDetail ? { publicDetail } : {}),
		retryable,
		...(retryable && retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
		diagnostics,
	});
}

export function providerFailurePublicMessage(failure: ProviderFailure): string {
	const base = runtimeErrorPublicMessage(failure.code);
	const context: string[] = [];
	const status = integerValue(failure.diagnostics.status);
	if (status !== undefined) context.push(`status ${status}`);
	const requestId = sanitizePublicToken(failure.diagnostics.request_id);
	if (requestId) context.push(`request id: ${requestId}`);
	const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
	const candidate = failure.publicDetail
		? `${base}: ${failure.publicDetail}${suffix}`
		: `${base}${suffix}`;
	return canonicalRuntimeFailureMessage(failure.code, candidate);
}

export function providerFailureToRuntimeFailure(failure: ProviderFailure): RuntimeFailure {
	const additionalDetails = providerFailureAdditionalDetails(failure);
	return {
		code: failure.code,
		message: runtimeErrorPublicMessage(failure.code),
		...(additionalDetails ? { additionalDetails } : {}),
		retryable: failure.retryable,
		...(Object.keys(failure.diagnostics).length > 0
			? { diagnostics: failure.diagnostics }
			: {}),
		...(failure.retryAfterSeconds === undefined
			? {}
			: { retryAfterSeconds: failure.retryAfterSeconds }),
	};
}

function providerFailureAdditionalDetails(failure: ProviderFailure): string | undefined {
	const context: string[] = [];
	const status = integerValue(failure.diagnostics.status);
	if (status !== undefined) context.push(`status ${status}`);
	const requestId = sanitizePublicToken(failure.diagnostics.request_id);
	if (requestId) context.push(`request id: ${requestId}`);
	const suffix = context.length > 0 ? ` (${context.join(", ")})` : "";
	return sanitizeRuntimeErrorDetail(`${failure.publicDetail ?? ""}${suffix}`);
}

function extractPublicDetail(
	error: unknown,
	record: Record<string, unknown>,
	nested: Record<string, unknown>,
	classification: {
		readonly status: number | undefined;
		readonly providerErrorCode: string | undefined;
		readonly providerErrorType: string | undefined;
	},
): string | undefined {
	const nestedError = isRecord(nested.error) ? nested.error : {};
	const bodyMessage = structuredBodyMessage(record.responseBody)
		?? structuredBodyMessage(record.body);
	const structuredMessage = stringValue(nested.message)
		?? stringValue(nestedError.message)
		?? bodyMessage;
	const providerShaped = classification.status !== undefined
		|| classification.providerErrorCode !== undefined
		|| classification.providerErrorType !== undefined
		|| !(error instanceof Error);
	const candidate = structuredMessage
		?? (providerShaped ? stringValue(record.message) : undefined);
	return candidate === undefined ? undefined : sanitizeRuntimeErrorDetail(candidate);
}

function structuredBodyMessage(value: unknown): string | undefined {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			return undefined;
		}
	}
	if (!isRecord(parsed)) return undefined;
	const nested = isRecord(parsed.error) ? parsed.error : {};
	return stringValue(nested.message) ?? stringValue(parsed.message);
}

function sanitizePublicToken(value: unknown): string | undefined {
	const token = typeof value === "string" ? value.slice(0, 128) : "";
	return /^[A-Za-z0-9_.:-]{1,128}$/u.test(token) ? token : undefined;
}

function retryAfterSeconds(headers: unknown): number | undefined {
	const retryAfterMilliseconds = numericHeaderValue(headers, "retry-after-ms");
	if (retryAfterMilliseconds !== undefined) {
		return boundedRetryAfterSeconds(retryAfterMilliseconds / 1_000);
	}
	const retryAfter = headerValue(headers, "retry-after");
	const seconds = numericValue(retryAfter);
	if (seconds !== undefined) return boundedRetryAfterSeconds(seconds);
	if (typeof retryAfter !== "string") return undefined;
	const retryAt = Date.parse(retryAfter);
	return Number.isFinite(retryAt)
		? boundedRetryAfterSeconds((retryAt - Date.now()) / 1_000)
		: undefined;
}

function retryAfterSecondsFromMessage(
	message: string | undefined,
	errorTokens: readonly string[],
): number | undefined {
	if (!message || !errorTokens.includes("rate_limit_exceeded")) return undefined;
	const match = /\btry again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)\b/iu.exec(message);
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return undefined;
	const unit = match[2]?.toLocaleLowerCase();
	return boundedRetryAfterSeconds(unit === "ms" ? amount / 1_000 : amount);
}

function boundedRetryAfterSeconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.min(RUNTIME_RETRY_AFTER_MAX_SECONDS, value))
		: undefined;
}

function numericHeaderValue(headers: unknown, name: string): number | undefined {
	return numericValue(headerValue(headers, name));
}

function numericValue(value: unknown): number | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function headerValue(headers: unknown, name: string): unknown {
	if (isRecordWithGet(headers)) return headers.get(name);
	if (!isRecord(headers)) return undefined;
	const entry = Object.entries(headers).find(([key]) => key.toLocaleLowerCase() === name);
	return entry?.[1];
}

function requestIdFromHeaders(headers: unknown): string | undefined {
	for (const name of ["x-request-id", "x-oai-request-id", "request-id"] as const) {
		let value: unknown;
		if (isRecordWithGet(headers)) {
			value = headers.get(name);
		} else if (isRecord(headers)) {
			value = headers[name];
		}
		const requestId = stringValue(value);
		if (requestId) return requestId;
	}
	return undefined;
}

function isContextWindowError(error: Record<string, unknown>): boolean {
	const nested = isRecord(error.error) ? error.error : {};
	const nestedError = isRecord(nested.error) ? nested.error : {};
	const values = [
		error.code,
		error.type,
		error.message,
		nested.code,
		nested.type,
		nested.message,
		nestedError.code,
		nestedError.type,
		nestedError.message,
	];
	return values.some((value) => typeof value === "string" && (
		value.toLowerCase().includes("context_window")
		|| value.toLowerCase().includes("maximum context length")
	));
}

function providerErrorTokens(
	record: Record<string, unknown>,
	nested: Record<string, unknown>,
	nestedError: Record<string, unknown>,
): readonly string[] {
	return [
		record.code,
		record.type,
		nested.code,
		nested.type,
		nestedError.code,
		nestedError.type,
	].flatMap((value) => {
		const token = safeErrorToken(value);
		return token ? [token.toLowerCase()] : [];
	});
}

function hasErrorToken(tokens: readonly string[], expected: ReadonlySet<string>): boolean {
	return tokens.some((token) => expected.has(token));
}

function transportErrorIdentity(error: unknown): Readonly<{
	readonly code?: string;
	readonly name?: string;
}> {
	let current = error;
	let code: string | undefined;
	let name: string | undefined;
	for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
		const currentCode = safeErrorToken(current.code);
		if (!code && currentCode && CONNECTION_ERROR_CODES.has(currentCode.toUpperCase())) {
			code = currentCode.toUpperCase();
		}
		const candidates = [
			safeErrorToken(current.name),
			current instanceof Error ? safeErrorToken(current.constructor.name) : undefined,
		];
		const currentName = candidates.find((candidate) => (
			candidate !== undefined && CONNECTION_ERROR_NAMES.has(candidate)
		));
		if (!name && currentName) name = currentName;
		current = current.cause;
	}
	return {
		...(code ? { code } : {}),
		...(name ? { name } : {}),
	};
}

function providerErrorNames(error: unknown): readonly string[] {
	if (!isRecord(error)) return [];
	return [
		safeErrorToken(error.name),
		error instanceof Error ? safeErrorToken(error.constructor.name) : undefined,
	].filter((value): value is string => value !== undefined);
}

function isAbortError(error: unknown, errorNames: readonly string[]): boolean {
	return error instanceof Error
		&& (errorNames.includes("AbortError") || errorNames.includes("APIUserAbortError"));
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function safeErrorToken(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value)
		? value
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordWithGet(value: unknown): value is { get(name: string): unknown } {
	return isRecord(value) && typeof value.get === "function";
}

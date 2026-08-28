import { createHash } from "node:crypto";
import type { RuntimeErrorCode } from "./generated/runtime-turn-record.ts";

export type RuntimeFailureDiagnosticValue = string | number | boolean | null;
export type RuntimeFailureDiagnostics = Readonly<Record<string, RuntimeFailureDiagnosticValue>>;
export type RuntimeErrorNoticeSeverity = "error" | "warning";
export const RUNTIME_RETRY_AFTER_MAX_SECONDS = 3_600;

export interface RuntimeFailure {
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly additionalDetails?: string;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;
	readonly diagnostics?: RuntimeFailureDiagnostics;
}

const RUNTIME_ERROR_PUBLIC_MESSAGES = Object.freeze({
	config_error: "provider configuration failed",
	auth_error: "provider authentication failed",
	permission_denied: "provider access was denied",
	invalid_request: "provider rejected the request",
	provider_error: "provider request failed",
	connection_error: "provider connection failed",
	response_stream_error: "provider response stream failed",
	server_overloaded: "provider is overloaded",
	rate_limited: "provider rate limit exceeded",
	quota_exceeded: "provider quota exceeded",
	context_window_exceeded: "provider context window exceeded",
	retry_exhausted: "provider retry budget exhausted",
	persistence_error: "session persistence failed",
	interrupted: "turn interrupted",
	unsupported_capability: "provider requested an unsupported capability",
	tool_budget_exceeded: "tool turn budget exceeded",
	tool_protocol_error: "provider tool protocol failed",
} satisfies Readonly<Record<RuntimeErrorCode, string>>);

const RUNTIME_ERROR_RECOVERY_HINTS = Object.freeze({
	config_error: "Update the provider configuration, then retry.",
	auth_error: "Check the configured provider credentials.",
	permission_denied: "Check that the account can access this model.",
	invalid_request: undefined,
	provider_error: undefined,
	connection_error: undefined,
	response_stream_error: undefined,
	server_overloaded: undefined,
	rate_limited: "Wait for the cooldown, then retry.",
	quota_exceeded: "Check the provider billing plan or quota.",
	context_window_exceeded: "Compact this conversation or start a new session.",
	retry_exhausted: undefined,
	persistence_error: undefined,
	interrupted: undefined,
	unsupported_capability: undefined,
	tool_budget_exceeded: undefined,
	tool_protocol_error: undefined,
} satisfies Readonly<Record<RuntimeErrorCode, string | undefined>>);

export const RUNTIME_ERROR_CODES: readonly RuntimeErrorCode[] = Object.freeze(
	Object.keys(RUNTIME_ERROR_PUBLIC_MESSAGES) as RuntimeErrorCode[],
);

const RUNTIME_ERROR_CODE_SET = new Set<string>(RUNTIME_ERROR_CODES);
const PUBLIC_DETAIL_MAX_CHARS = 1_000;
const PUBLIC_FAILURE_MESSAGE_MAX_CHARS = 2_048;
const ESCAPE_CHARACTER = String.fromCharCode(0x1b);
const BELL_CHARACTER = String.fromCharCode(0x07);
const ANSI_SEQUENCE = new RegExp(
	`${ESCAPE_CHARACTER}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\))`,
	"gu",
);
const STACK_DETAIL = /(?:^|\s)(?:at\s+|node:internal|file:\/\/|[A-Za-z0-9_.-]+\.(?:[cm]?[jt]s|tsx?):\d+:\d+)/u;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|password|secret|token|credential|cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const SECRET_QUERY = /([?&](?:api[_-]?key|authorization|password|secret|token|credential|key)=)[^&#\s]+/giu;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/giu;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/gu;
const GOOGLE_STYLE_KEY = /\bAIza[A-Za-z0-9_-]{20,}\b/gu;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const SDK_EMPTY_BODY_STATUS_PREFIX = /^\d{3}\s+status code\s+\(no body\)(?=\s*(?:\(|$))/iu;

export function isRuntimeErrorCode(value: unknown): value is RuntimeErrorCode {
	return typeof value === "string" && RUNTIME_ERROR_CODE_SET.has(value);
}

export function runtimeErrorPublicMessage(code: RuntimeErrorCode): string {
	return RUNTIME_ERROR_PUBLIC_MESSAGES[code];
}

export function runtimeErrorRecoveryHint(code: RuntimeErrorCode): string | undefined {
	return RUNTIME_ERROR_RECOVERY_HINTS[code];
}

export function runtimeErrorNoticeSeverity(code: RuntimeErrorCode): RuntimeErrorNoticeSeverity {
	return code === "server_overloaded" ? "warning" : "error";
}

export function runtimeRetryStatusText(
	code: RuntimeErrorCode,
	attempt: number,
	maxRetries: number,
): string {
	const normalizedAttempt = boundedPositiveInteger(attempt, 1);
	const normalizedMax = Math.max(normalizedAttempt, boundedPositiveInteger(maxRetries, normalizedAttempt));
	const verb = code === "connection_error" || code === "response_stream_error"
		? "Reconnecting"
		: "Retrying";
	return `${verb}... ${normalizedAttempt}/${normalizedMax}`;
}

export function sanitizeRuntimeErrorDetail(value: unknown): string | undefined {
	return sanitizeRuntimeErrorText(value, PUBLIC_DETAIL_MAX_CHARS);
}

export function canonicalRuntimeFailureMessage(code: string, candidate?: string): string {
	const runtimeCode = isRuntimeErrorCode(code) ? code : "provider_error";
	const fallback = runtimeErrorPublicMessage(runtimeCode);
	const sanitized = sanitizeRuntimeErrorText(candidate, PUBLIC_FAILURE_MESSAGE_MAX_CHARS);
	if (!sanitized) return fallback;
	const normalized = sanitized.toLocaleLowerCase();
	const prefix = fallback.toLocaleLowerCase();
	return normalized === prefix
		|| normalized.startsWith(`${prefix}:`)
		|| normalized.startsWith(`${prefix} (`)
		? sanitized
		: fallback;
}

export function canonicalTurnFailureMessage(code: string, candidate?: string): string {
	return canonicalRuntimeFailureMessage(code, candidate);
}

export function turnFailedNoticeId(turnId: string): string {
	const identity = createHash("sha256").update(turnId).digest("hex");
	return `turn-failed:${identity}`;
}

export function turnFailureNotice(code: string, candidate?: string): string {
	const message = canonicalRuntimeFailureMessage(code, candidate);
	const sentence = `${message.charAt(0).toLocaleUpperCase()}${message.slice(1)}`;
	return /[.!?。！？]$/u.test(sentence) ? sentence : `${sentence}.`;
}

function sanitizeRuntimeErrorText(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const redacted = stripControlCharacters(value.replace(ANSI_SEQUENCE, ""))
		.replace(BEARER_TOKEN, "Bearer [REDACTED]")
		.replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`)
		.replace(SECRET_QUERY, "$1[REDACTED]")
		.replace(OPENAI_STYLE_KEY, "[REDACTED]")
		.replace(GOOGLE_STYLE_KEY, "[REDACTED]")
		.replace(JWT_TOKEN, "[REDACTED]")
		.replace(/(?:\/Users|\/home)\/[^/\s]+/gu, "~")
		.replace(/[A-Za-z]:\\Users\\[^\\\s]+/gu, "~")
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !STACK_DETAIL.test(line))
		.join(" ")
		.replace(/\s+/gu, " ")
		.trim();
	const sanitized = redacted.replace(SDK_EMPTY_BODY_STATUS_PREFIX, "").trim();
	return sanitized ? [...sanitized].slice(0, maxChars).join("") : undefined;
}

function stripControlCharacters(value: string): string {
	return [...value].map((character) => {
		const code = character.charCodeAt(0);
		const permittedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
		return (code < 0x20 && !permittedWhitespace) || code === 0x7f ? " " : character;
	}).join("");
}

function boundedPositiveInteger(value: number, fallback: number): number {
	return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : fallback;
}

import { createHash } from "node:crypto";
import type { RuntimeErrorCode } from "../generated/runtime-turn-record.ts";
import type { ErrorContext } from "../errors/error-context.ts";
import { LEGACY_RUNTIME_ERRORS } from "../errors/legacy.ts";
import { errorSummary } from "../errors/presentation.ts";
import { runtimeErrorRecoveryActions } from "./diagnostics.ts";

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
	readonly errorContext?: ErrorContext;
}

export const RUNTIME_ERROR_CODES: readonly RuntimeErrorCode[] = Object.freeze(
	Object.keys(LEGACY_RUNTIME_ERRORS) as RuntimeErrorCode[],
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
	return LEGACY_RUNTIME_ERRORS[code].message;
}

export function runtimeErrorRecoveryHint(code: RuntimeErrorCode): string | undefined {
	return LEGACY_RUNTIME_ERRORS[code].hint ? runtimeErrorRecoveryActions(code)[0]?.label : undefined;
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

export function canonicalRuntimeFailureMessage(code: string, candidate?: string, errorContext?: ErrorContext): string {
	if (errorContext) return errorSummary(errorContext);
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

export function canonicalTurnFailureMessage(code: string, candidate?: string, errorContext?: ErrorContext): string {
	return canonicalRuntimeFailureMessage(code, candidate, errorContext);
}

export function turnFailedNoticeId(turnId: string): string {
	const identity = createHash("sha256").update(turnId).digest("hex");
	return `turn-failed:${identity}`;
}

export function turnFailureNotice(code: string, candidate?: string, errorContext?: ErrorContext): string {
	const message = canonicalRuntimeFailureMessage(code, candidate, errorContext);
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

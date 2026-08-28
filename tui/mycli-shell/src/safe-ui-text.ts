import { homedir } from "node:os";

const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|bearer|password|secret|token)\b\s*[:=]\s*([^\s,;]+)/giu;
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/giu;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{12,}\b/gu;
const STACK_DETAIL = /(?:^|\s)(?:at\s+|node:internal|file:\/\/|[A-Za-z0-9_.-]+\.(?:[cm]?[jt]s|tsx?):\d+:\d+)/u;

export function boundedUiText(value: unknown, fallback: string, maxChars = 2_048): string {
	if (typeof value !== "string") return fallback;
	const sanitized = redactUiText(value)
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line && !STACK_DETAIL.test(line))
		.join(" ")
		.trim();
	return sanitized ? sanitized.slice(0, maxChars) : fallback;
}

export function safeErrorMessage(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return fallback;
	return boundedUiText(error.message, fallback, 512);
}

function redactUiText(value: string): string {
	const home = homedir();
	return value
		.replace(ANSI_SEQUENCE, "")
		.replace(CONTROL_CHARACTER, "")
		.replace(BEARER_TOKEN, "Bearer [REDACTED]")
		.replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`)
		.replace(OPENAI_STYLE_KEY, "[REDACTED]")
		.replaceAll(home, "~");
}

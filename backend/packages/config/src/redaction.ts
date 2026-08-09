const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(authorization|api.?key|token|secret|password|cookie)/i;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

export function redactValue(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(BEARER, "Bearer [REDACTED]").replace(OPENAI_KEY, REDACTED);
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item));
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item),
		]),
	);
}

/**
 * Tool arguments reach the runtime as raw JSON. Approvals and tool rows both want the same
 * compact `key=value · key=value` preview, so parsing and formatting live in one place.
 */

const MAX_PREVIEW_ENTRIES = 4;
const MAX_PREVIEW_VALUE_CHARS = 48;

export function parseToolArguments(value: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Readonly<Record<string, unknown>>
			: undefined;
	} catch {
		return undefined;
	}
}

export function formatArgumentPreview(
	value: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
	if (!value) return undefined;
	const entries = Object.entries(value);
	if (entries.length === 0) return undefined;
	const parts = entries.slice(0, MAX_PREVIEW_ENTRIES).map(([key, entry]) => {
		const text = typeof entry === "string" ? entry : stringifyValue(entry);
		return `${key}=${text.length > MAX_PREVIEW_VALUE_CHARS
			? `${text.slice(0, MAX_PREVIEW_VALUE_CHARS - 1)}…`
			: text}`;
	});
	if (entries.length > MAX_PREVIEW_ENTRIES) parts.push(`+${entries.length - MAX_PREVIEW_ENTRIES} more`);
	return parts.join(" · ");
}

function stringifyValue(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

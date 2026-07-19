import type {
	MycliShellCommandDisplay,
	MycliShellCommandField,
	MycliShellCommandResult,
	MycliShellCommandRow,
	MycliShellCommandSection,
} from "../model.ts";

const MAX_TEXT_CHARS = 8_000;
const MAX_ROWS = 100;
const MAX_SECTIONS = 16;
const MAX_FIELDS = 100;
const MAX_SUGGESTIONS = 3;

const DISPLAY_KINDS = new Set(["status", "diagnostic", "list", "notice", "error", "preformatted"]);
const DISPLAY_SEVERITIES = new Set(["info", "success", "warning", "error"]);

type TranscriptCommandResultItem = {
	id: string;
	text: string;
	folded?: boolean;
	metadata?: Record<string, unknown>;
};

export function commandResultFromGateway(value: unknown): MycliShellCommandResult | null {
	const payload = objectValue(value);
	if (!payload) return null;
	const id = requiredString(payload.result_id);
	const display = commandDisplayFromUnknown(payload.display);
	if (!id || !display) return null;
	return {
		id,
		display,
		fallbackLines: stringArray(payload.lines, MAX_ROWS),
		folded: booleanValue(payload.folded) ?? false,
	};
}

export function commandResultFromTranscriptItem(item: TranscriptCommandResultItem): MycliShellCommandResult | null {
	const metadata = objectValue(item.metadata) ?? {};
	const display = commandDisplayFromUnknown(metadata.display);
	if (!display) return null;
	const fallbackLines = stringArray(metadata.fallback_lines, MAX_ROWS);
	return {
		id: item.id,
		display,
		fallbackLines: fallbackLines.length > 0 ? fallbackLines : bounded(item.text).split(/\r?\n/),
		folded: item.folded ?? booleanValue(metadata.folded) ?? false,
	};
}

function commandDisplayFromUnknown(value: unknown): MycliShellCommandDisplay | null {
	const payload = objectValue(value);
	if (!payload || payload.version !== 1) return null;
	const kind = requiredString(payload.kind);
	const severity = requiredString(payload.severity);
	const command = requiredString(payload.command);
	const title = requiredString(payload.title);
	if (!kind || !DISPLAY_KINDS.has(kind) || !severity || !DISPLAY_SEVERITIES.has(severity) || !command || !title) {
		return null;
	}
	const summary = optionalString(payload, "summary");
	const usage = optionalString(payload, "usage");
	const preformatted = optionalString(payload, "preformatted", MAX_TEXT_CHARS);
	const totalRows = optionalInteger(payload, "total_rows");
	const omittedRows = optionalInteger(payload, "omitted_rows");
	const omittedChars = optionalInteger(payload, "omitted_chars");
	if (!summary.valid || !usage.valid || !preformatted.valid || !totalRows.valid || !omittedRows.valid || !omittedChars.valid) {
		return null;
	}
	const fields = parsedArray(payload.fields, fieldFromUnknown, MAX_FIELDS);
	const rows = parsedArray(payload.rows, rowFromUnknown, MAX_ROWS);
	const sections = parsedArray(payload.sections, sectionFromUnknown, MAX_SECTIONS);
	const suggestions = optionalStringArray(payload, "suggestions", MAX_SUGGESTIONS);
	if (!fields || !rows || !sections || !suggestions) return null;
	return {
		version: 1,
		kind: kind as MycliShellCommandDisplay["kind"],
		command,
		title,
		severity: severity as MycliShellCommandDisplay["severity"],
		...(summary.value !== undefined ? { summary: summary.value } : {}),
		fields,
		rows,
		sections,
		...(usage.value !== undefined ? { usage: usage.value } : {}),
		suggestions,
		...(preformatted.value !== undefined ? { preformatted: preformatted.value } : {}),
		...(totalRows.value !== undefined ? { totalRows: totalRows.value } : {}),
		omittedRows: omittedRows.value ?? 0,
		omittedChars: omittedChars.value ?? 0,
	};
}

function fieldFromUnknown(value: unknown): MycliShellCommandField | null {
	const payload = objectValue(value);
	if (!payload) return null;
	const label = requiredString(payload.label);
	const fieldValue = stringValue(payload.value);
	const tone = optionalString(payload, "tone");
	if (!label || fieldValue === null || !tone.valid) return null;
	return { label, value: fieldValue, ...(tone.value !== undefined ? { tone: tone.value } : {}) };
}

function rowFromUnknown(value: unknown): MycliShellCommandRow | null {
	const payload = objectValue(value);
	if (!payload) return null;
	const key = requiredString(payload.key);
	const label = requiredString(payload.label);
	const values = optionalStringArray(payload, "values", MAX_FIELDS);
	const status = optionalString(payload, "status");
	const detail = optionalString(payload, "detail");
	if (!key || !label || !values || !status.valid || !detail.valid) return null;
	return {
		key,
		label,
		values,
		...(status.value !== undefined ? { status: status.value } : {}),
		...(detail.value !== undefined ? { detail: detail.value } : {}),
	};
}

function sectionFromUnknown(value: unknown): MycliShellCommandSection | null {
	const payload = objectValue(value);
	if (!payload) return null;
	const title = requiredString(payload.title);
	const fields = parsedArray(payload.fields, fieldFromUnknown, MAX_FIELDS);
	const rows = parsedArray(payload.rows, rowFromUnknown, MAX_ROWS);
	if (!title || !fields || !rows) return null;
	return { title, fields, rows };
}

function parsedArray<T>(value: unknown, parser: (item: unknown) => T | null, limit: number): T[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return null;
	const parsed: T[] = [];
	for (const item of value.slice(0, limit)) {
		const result = parser(item);
		if (result === null) return null;
		parsed.push(result);
	}
	return parsed;
}

function optionalStringArray(payload: Record<string, unknown>, key: string, limit: number): string[] | null {
	if (!(key in payload)) return [];
	if (!Array.isArray(payload[key]) || !payload[key].every((item) => typeof item === "string")) return null;
	return (payload[key] as string[]).slice(0, limit).map((item) => bounded(item));
}

function stringArray(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").slice(0, limit).map((item) => bounded(item));
}

function optionalString(
	payload: Record<string, unknown>,
	key: string,
	limit = 2_048,
): { valid: boolean; value?: string } {
	if (!(key in payload)) return { valid: true };
	const value = payload[key];
	if (typeof value !== "string") return { valid: false };
	return { valid: true, value: bounded(value, limit) };
}

function optionalInteger(payload: Record<string, unknown>, key: string): { valid: boolean; value?: number } {
	if (!(key in payload)) return { valid: true };
	const value = payload[key];
	if (!Number.isInteger(value) || (value as number) < 0) return { valid: false };
	return { valid: true, value: value as number };
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function requiredString(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	return bounded(value.trim());
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? bounded(value) : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function bounded(value: string, limit = 2_048): string {
	return value.length <= limit ? value : value.slice(0, limit);
}

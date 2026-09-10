import { randomUUID } from "node:crypto";
import type {
	ResolvedSlashCommand,
	SlashCommandPresentation,
} from "./node-slash-command-registry.ts";

type JsonObject = Record<string, unknown>;

const MAX_ROWS = 100;
const MAX_FIELDS = 100;
const MAX_VALUE_CHARS = 2_048;

interface CommandField {
	readonly label: string;
	readonly value: string;
	readonly tone?: string;
}

interface CommandRow {
	readonly key: string;
	readonly label: string;
	readonly values?: readonly string[];
	readonly status?: string;
	readonly detail?: string;
}

export function statusCommandResult(
	invocation: ResolvedSlashCommand,
	fields: readonly CommandField[],
): JsonObject {
	return commandResult(invocation, display({ kind: "status", title: "mycli", fields }));
}

export function diagnosticCommandResult(
	invocation: ResolvedSlashCommand,
	title: string,
	fields: readonly CommandField[],
): JsonObject {
	return commandResult(invocation, display({ kind: "diagnostic", title, fields }));
}

export function listCommandResult(
	invocation: ResolvedSlashCommand,
	title: string,
	rows: readonly CommandRow[],
): JsonObject {
	const boundedRows = rows.slice(0, MAX_ROWS);
	return commandResult(invocation, display({
		kind: "list",
		title,
		summary: `${rows.length} ${rows.length === 1 ? "item" : "items"}`,
		rows: boundedRows,
		totalRows: rows.length,
		omittedRows: Math.max(0, rows.length - boundedRows.length),
	}));
}

export function noticeCommandResult(
	invocation: ResolvedSlashCommand,
	title: string,
	summary: string,
	options: {
		readonly severity?: "info" | "success" | "warning" | "error";
		readonly presentation?: SlashCommandPresentation;
		readonly extra?: JsonObject;
	} = {},
): JsonObject {
	return commandResult(invocation, display({
		kind: "notice",
		title,
		summary,
		severity: options.severity ?? "success",
	}), options);
}

export function errorCommandResult(
	invocation: ResolvedSlashCommand,
	reason: string,
	usage?: string,
): JsonObject {
	return commandResult(invocation, display({
		kind: "error",
		title: "Command error",
		severity: "error",
		summary: reason,
		...(usage ? { usage } : {}),
	}));
}

export function preformattedCommandResult(
	invocation: ResolvedSlashCommand,
	title: string,
	lines: readonly string[],
	options: {
		readonly presentation?: SlashCommandPresentation;
		readonly extra?: JsonObject;
	} = {},
): JsonObject {
	const boundedLines = lines.slice(0, MAX_ROWS).map((line) => bounded(line));
	return commandResult(invocation, display({
		kind: "preformatted",
		title,
		preformatted: boundedLines.join("\n"),
		omittedRows: Math.max(0, lines.length - boundedLines.length),
	}), options);
}

function commandResult(
	invocation: ResolvedSlashCommand,
	displayPayload: JsonObject,
	options: {
		readonly presentation?: SlashCommandPresentation;
		readonly extra?: JsonObject;
	} = {},
): JsonObject {
	const presentation = options.presentation ?? invocation.presentation;
	const command = [invocation.canonicalName, invocation.args].filter(Boolean).join(" ");
	const projectedDisplay = { ...displayPayload, command };
	return {
		execution: "backend",
		...(presentation === "transcript"
			? { result_id: `command:${randomUUID().replaceAll("-", "")}` }
			: {}),
		presentation,
		display: projectedDisplay,
		lines: renderDisplay(projectedDisplay),
		mutated_session: false,
		mutated_model: false,
		mutated_mode: false,
		exit_requested: false,
		...(options.extra ?? {}),
	};
}

function display(input: {
	readonly kind: "status" | "diagnostic" | "list" | "notice" | "error" | "preformatted";
	readonly title: string;
	readonly severity?: "info" | "success" | "warning" | "error";
	readonly summary?: string;
	readonly fields?: readonly CommandField[];
	readonly rows?: readonly CommandRow[];
	readonly usage?: string;
	readonly preformatted?: string;
	readonly totalRows?: number;
	readonly omittedRows?: number;
}): JsonObject {
	return {
		version: 1,
		kind: input.kind,
		command: "",
		title: bounded(input.title),
		severity: input.severity ?? "info",
		...(input.summary ? { summary: bounded(input.summary) } : {}),
		fields: (input.fields ?? []).slice(0, MAX_FIELDS).map((field) => ({
			label: bounded(field.label),
			value: bounded(field.value),
			...(field.tone ? { tone: bounded(field.tone) } : {}),
		})),
		rows: (input.rows ?? []).slice(0, MAX_ROWS).map((row) => ({
			key: bounded(row.key),
			label: bounded(row.label),
			values: (row.values ?? []).slice(0, MAX_FIELDS).map((value) => bounded(value)),
			...(row.status ? { status: bounded(row.status) } : {}),
			...(row.detail ? { detail: bounded(row.detail) } : {}),
		})),
		sections: [],
		...(input.usage ? { usage: bounded(input.usage) } : {}),
		...(input.preformatted ? { preformatted: bounded(input.preformatted) } : {}),
		suggestions: [],
		...(input.totalRows === undefined ? {} : { total_rows: input.totalRows }),
		omitted_rows: input.omittedRows ?? 0,
		omitted_chars: 0,
	};
}

function renderDisplay(value: JsonObject): string[] {
	const title = typeof value.title === "string" ? value.title : "Command result";
	const summary = typeof value.summary === "string" ? value.summary : undefined;
	const lines = [title];
	if (summary) lines.push(summary);
	if (Array.isArray(value.fields)) {
		for (const field of value.fields.slice(0, MAX_FIELDS)) {
			if (!isObject(field)) continue;
			lines.push(`${String(field.label ?? "Value")}: ${String(field.value ?? "")}`);
		}
	}
	if (Array.isArray(value.rows)) {
		for (const row of value.rows.slice(0, MAX_ROWS)) {
			if (!isObject(row)) continue;
			const values = Array.isArray(row.values) ? row.values.map(String) : [];
			lines.push([String(row.label ?? "Item"), ...values].join(" ").trim());
		}
	}
	if (typeof value.preformatted === "string") lines.push(...value.preformatted.split("\n"));
	if (typeof value.usage === "string") lines.push(`Usage: ${value.usage}`);
	return lines.slice(0, MAX_ROWS).map((line) => bounded(line));
}

function bounded(value: string): string {
	return value.length <= MAX_VALUE_CHARS ? value : value.slice(0, MAX_VALUE_CHARS);
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { createHash } from "node:crypto";
import {
	readFile as readFileBytes,
	stat,
} from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "csv-parse/sync";

const MAX_STRUCTURED_BYTES = 8 * 1024 * 1024;
const MAX_READ_LIMIT = 500;
const SMALL_FILE_ROW_LIMIT = 50;
const HEAD_PREVIEW_ROWS = 20;
const TAIL_PREVIEW_ROWS = 10;

export type DelimitedReadErrorKind =
	| "file_too_large"
	| "empty_file"
	| "invalid_encoding"
	| "invalid_delimited_data"
	| "permission_denied"
	| "interrupted"
	| "read_failed";

export class DelimitedReadError extends Error {
	readonly kind: DelimitedReadErrorKind;

	constructor(kind: DelimitedReadErrorKind) {
		super(`read_delimited_error: ${kind}`);
		this.name = "DelimitedReadError";
		this.kind = kind;
	}
}

export interface NumericColumnSummary {
	readonly count: number;
	readonly sum: number;
	readonly average: number;
	readonly min: number;
	readonly minLine: number;
	readonly minContext: string;
	readonly max: number;
	readonly maxLine: number;
	readonly maxContext: string;
}

export interface DelimitedReadResult {
	readonly headers: readonly string[];
	readonly preview: readonly Readonly<Record<string, string>>[];
	readonly tailPreview?: readonly Readonly<Record<string, string>>[];
	readonly rows: number;
	readonly columns: number;
	readonly content: string;
	readonly numericSummary: Readonly<Record<string, NumericColumnSummary>>;
	readonly totalLines: number;
	readonly shownLines: number;
	readonly truncated: boolean;
	readonly requestedLimit: number;
	readonly effectiveLimit: number;
	readonly limitClamped: boolean;
	readonly mtimeNs: string;
	readonly size: number;
	readonly sha256: string;
	readonly capturedAt: string;
}

export async function readDelimitedFile(
	path: string,
	options: {
		readonly offset: number;
		readonly limit: number;
		readonly signal: AbortSignal;
	},
): Promise<DelimitedReadResult> {
	assertNotAborted(options.signal);
	try {
		const fileStat = await stat(path, { bigint: true });
		if (fileStat.size > BigInt(MAX_STRUCTURED_BYTES)) {
			throw new DelimitedReadError("file_too_large");
		}
		const raw = await readFileBytes(path);
		assertNotAborted(options.signal);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
		} catch {
			throw new DelimitedReadError("invalid_encoding");
		}
		const delimiter = extname(path).toLowerCase() === ".tsv" ? "\t" : ",";
		let parsed: string[][];
		try {
			parsed = parse(text, {
				bom: true,
				delimiter,
				relax_column_count: true,
				skip_empty_lines: false,
			}) as string[][];
		} catch {
			throw new DelimitedReadError("invalid_delimited_data");
		}
		if (parsed.length === 0) {
			throw new DelimitedReadError("empty_file");
		}
		const headers = parsed[0] ?? [];
		const data = parsed.slice(1);
		const requestedLimit = Math.trunc(options.limit);
		const effectiveLimit = Math.min(Math.max(0, requestedLimit), MAX_READ_LIMIT);
		const common = {
			headers,
			rows: data.length,
			columns: headers.length,
			numericSummary: numericSummary(headers, data),
			totalLines: parsed.length,
			requestedLimit,
			effectiveLimit,
			limitClamped: requestedLimit !== effectiveLimit,
			mtimeNs: fileStat.mtimeNs.toString(),
			size: raw.length,
			sha256: createHash("sha256").update(raw).digest("hex"),
			capturedAt: new Date().toISOString(),
		};
		const offset = Math.max(1, Math.trunc(options.offset));
		if (offset > 1) {
			const start = Math.min(offset - 1, parsed.length);
			const selected = parsed.slice(start, start + effectiveLimit);
			return {
				...common,
				preview: selected.map((row) => rowRecord(headers, row)),
				content: formatRows(selected, delimiter, headers),
				shownLines: selected.length,
				truncated: start + selected.length < parsed.length,
			};
		}
		if (data.length <= SMALL_FILE_ROW_LIMIT) {
			return {
				...common,
				preview: data.map((row) => rowRecord(headers, row)),
				content: formatRows(parsed, delimiter)
					+ formatNumericProfile(common.numericSummary),
				shownLines: parsed.length,
				truncated: false,
			};
		}
		const selected = parsed.slice(0, HEAD_PREVIEW_ROWS + 1);
		return {
			...common,
			preview: data.slice(0, HEAD_PREVIEW_ROWS).map((row) => rowRecord(headers, row)),
			tailPreview: data.slice(-TAIL_PREVIEW_ROWS).map((row) => rowRecord(headers, row)),
			content: formatRows(selected, delimiter) + formatNumericProfile(common.numericSummary),
			shownLines: selected.length,
			truncated: true,
		};
	} catch (error) {
		if (error instanceof DelimitedReadError) {
			throw error;
		}
		if (options.signal.aborted) {
			throw new DelimitedReadError("interrupted");
		}
		if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
			throw new DelimitedReadError("permission_denied");
		}
		throw new DelimitedReadError("read_failed");
	}
}

function numericSummary(
	headers: readonly string[],
	rows: readonly (readonly string[])[],
): Readonly<Record<string, NumericColumnSummary>> {
	const summaries: Record<string, NumericColumnSummary> = {};
	for (const [columnIndex, header] of headers.entries()) {
		const values: Array<{ line: number; value: number; row: readonly string[] }> = [];
		for (const [rowIndex, row] of rows.entries()) {
			const value = parseNumber(row[columnIndex]);
			if (value !== undefined) {
				values.push({ line: rowIndex + 2, value, row });
			}
		}
		if (values.length === 0) {
			continue;
		}
		const min = values.reduce((left, right) => right.value < left.value ? right : left);
		const max = values.reduce((left, right) => right.value > left.value ? right : left);
		const sum = values.reduce((total, item) => total + item.value, 0);
		summaries[header] = {
			count: values.length,
			sum: jsonNumber(sum),
			average: jsonNumber(sum / values.length),
			min: jsonNumber(min.value),
			minLine: min.line,
			minContext: rowContext(headers, min.row),
			max: jsonNumber(max.value),
			maxLine: max.line,
			maxContext: rowContext(headers, max.row),
		};
	}
	return summaries;
}

function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined || !value.trim()) {
		return undefined;
	}
	const parsed = Number(value.trim().replaceAll(",", ""));
	return Number.isFinite(parsed) ? parsed : undefined;
}

function rowContext(headers: readonly string[], row: readonly string[]): string {
	const parts: string[] = [];
	for (const [index, header] of headers.entries()) {
		const value = row[index]?.trim();
		if (value && parseNumber(value) === undefined) {
			parts.push(`${header}=${value.replaceAll(/\s+/g, " ")}`);
		}
		if (parts.length === 2) {
			break;
		}
	}
	return parts.join(", ");
}

function rowRecord(
	headers: readonly string[],
	row: readonly string[],
): Readonly<Record<string, string>> {
	return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
}

function formatRows(
	rows: readonly (readonly string[])[],
	delimiter: string,
	columns?: readonly string[],
): string {
	const lines = [
		...(columns ? [`Columns: ${serializeRow(columns, delimiter)}`] : []),
		...rows.map((row) => serializeRow(row, delimiter)),
	];
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function serializeRow(row: readonly string[], delimiter: string): string {
	return row.map((value) => {
		if (!value.includes(delimiter) && !/["\r\n]/.test(value)) {
			return value;
		}
		return `"${value.replaceAll('"', '""')}"`;
	}).join(delimiter);
}

function formatNumericProfile(
	summaries: Readonly<Record<string, NumericColumnSummary>>,
): string {
	const entries = Object.entries(summaries);
	if (entries.length === 0) {
		return "";
	}
	return `Data profile:\n${entries.map(([name, summary]) =>
		`- ${name}: sum=${summary.sum} avg=${summary.average} min=${summary.min} `
		+ `line=${summary.minLine} max=${summary.max} line=${summary.maxLine}`).join("\n")}\n`;
}

function jsonNumber(value: number): number {
	return Number(value.toFixed(4));
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new DelimitedReadError("interrupted");
	}
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& error.code === code;
}

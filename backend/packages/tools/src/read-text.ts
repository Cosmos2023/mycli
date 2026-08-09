import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const MAX_READ_LIMIT = 500;
const MAX_LINE_CHARS = 2_000;
const SAMPLE_BYTES = 1_024;
const STREAM_CHUNK_BYTES = 512 * 1_024;

export type ReadContentErrorKind =
	| "invalid_encoding"
	| "binary_file"
	| "permission_denied"
	| "interrupted"
	| "read_failed";

export class ReadContentError extends Error {
	readonly kind: ReadContentErrorKind;

	constructor(kind: ReadContentErrorKind) {
		super(`read_content_error: ${kind}`);
		this.name = "ReadContentError";
		this.kind = kind;
	}
}

export interface ReadTextWindowOptions {
	readonly offset: number;
	readonly limit: number;
	readonly signal: AbortSignal;
}

export interface TextReadResult {
	readonly content: string;
	readonly mtimeNs: string;
	readonly size: number;
	readonly sha256: string;
	readonly capturedAt: string;
	readonly totalChars: number;
	readonly totalLines: number;
	readonly shownLines: number;
	readonly truncated: boolean;
	readonly requestedLimit: number;
	readonly effectiveLimit: number;
	readonly limitClamped: boolean;
}

export async function readTextWindow(
	path: string,
	options: ReadTextWindowOptions,
): Promise<TextReadResult> {
	assertNotAborted(options.signal);
	const offset = Math.max(1, Math.trunc(options.offset));
	const requestedLimit = Math.trunc(options.limit);
	const effectiveLimit = Math.min(Math.max(0, requestedLimit), MAX_READ_LIMIT);
	const selectedLines: string[] = [];
	const digest = createHash("sha256");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	let totalChars = 0;
	let totalLines = 0;
	let sample = Buffer.alloc(0);
	let fileHandle;

	try {
		fileHandle = await open(path, "r");
		const fileStat = await fileHandle.stat({ bigint: true });
		const stream = fileHandle.createReadStream({
			autoClose: false,
			highWaterMark: STREAM_CHUNK_BYTES,
		});
		for await (const value of stream) {
			assertNotAborted(options.signal);
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			digest.update(chunk);
			if (sample.length < SAMPLE_BYTES) {
				sample = Buffer.concat([sample, chunk.subarray(0, SAMPLE_BYTES - sample.length)]);
			}
			const decoded = decoder.decode(chunk, { stream: true });
			totalChars += decoded.length;
			const pieces = (pending + decoded).split("\n");
			pending = pieces.pop() ?? "";
			for (const line of pieces) {
				selectLine(line, offset, effectiveLimit, totalLines, selectedLines);
				totalLines += 1;
			}
		}
		const tail = decoder.decode();
		totalChars += tail.length;
		pending += tail;
		if (pending) {
			selectLine(pending, offset, effectiveLimit, totalLines, selectedLines);
			totalLines += 1;
		}
		if (looksBinary(sample)) {
			throw new ReadContentError("binary_file");
		}
		const truncated = offset - 1 + selectedLines.length < totalLines;
		let content = formatLines(selectedLines);
		if (truncated) {
			const nextOffset = offset + selectedLines.length;
			content += `... (output truncated, showing ${selectedLines.length} of ${totalLines} lines; `
				+ `use offset=${nextOffset} with limit to continue)\n`;
		}
		return {
			content,
			mtimeNs: fileStat.mtimeNs.toString(),
			size: Number(fileStat.size),
			sha256: digest.digest("hex"),
			capturedAt: new Date().toISOString(),
			totalChars,
			totalLines,
			shownLines: selectedLines.length,
			truncated,
			requestedLimit,
			effectiveLimit,
			limitClamped: requestedLimit !== effectiveLimit,
		};
	} catch (error) {
		if (error instanceof ReadContentError) {
			throw error;
		}
		if (options.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
			throw new ReadContentError("interrupted");
		}
		if (error instanceof TypeError) {
			throw new ReadContentError("invalid_encoding");
		}
		if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
			throw new ReadContentError("permission_denied");
		}
		throw new ReadContentError("read_failed");
	} finally {
		await fileHandle?.close();
	}
}

function selectLine(
	line: string,
	offset: number,
	limit: number,
	zeroBasedLine: number,
	selectedLines: string[],
): void {
	const lineNumber = zeroBasedLine + 1;
	if (lineNumber < offset || selectedLines.length >= limit) {
		return;
	}
	selectedLines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
}

function formatLines(lines: readonly string[]): string {
	if (lines.length === 0) {
		return "";
	}
	return `${lines.map((line) => line.length > MAX_LINE_CHARS
		? `${line.slice(0, MAX_LINE_CHARS)} [... truncated]`
		: line).join("\n")}\n`;
}

function looksBinary(sample: Uint8Array): boolean {
	if (sample.includes(0)) {
		return true;
	}
	if (sample.length === 0) {
		return false;
	}
	const allowedControls = new Set([7, 8, 9, 10, 12, 13, 27]);
	let suspicious = 0;
	for (const byte of sample) {
		if (byte < 32 && !allowedControls.has(byte)) {
			suspicious += 1;
		}
	}
	return suspicious / sample.length > 0.3;
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new ReadContentError("interrupted");
	}
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& error.code === code;
}

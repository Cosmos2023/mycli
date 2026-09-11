import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { HeadlessError } from "./types.ts";

export const MAX_PROMPT_BYTES = 1024 * 1024;
export const MAX_FINAL_BYTES = 4 * 1024 * 1024;

export interface HeadlessInput extends NodeJS.ReadableStream {
	readonly isTTY?: boolean;
}

export async function readBoundedText(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new HeadlessError("input_file_invalid", 2);
		const bytes = await file.readFile({ ...(signal ? { signal } : {}) });
		if (bytes.length > maxBytes) throw new HeadlessError("input_file_too_large", 2);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} finally {
		await file.close();
	}
}

export async function readPrompt(input: HeadlessInput, signal: AbortSignal): Promise<string> {
	if (input.isTTY === true || typeof input.on !== "function") throw new HeadlessError("prompt_required", 2);
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let length = 0;
		const cleanup = (): void => {
			input.off("data", onData);
			input.off("end", onEnd);
			input.off("error", onError);
			input.off("close", onClose);
			signal.removeEventListener("abort", onAbort);
			input.pause();
		};
		const fail = (error: unknown): void => { cleanup(); reject(error); };
		const onData = (chunk: Buffer | string): void => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			length += bytes.length;
			if (length > MAX_PROMPT_BYTES) { fail(new HeadlessError("prompt_too_large", 2)); return; }
			chunks.push(bytes);
		};
		const onEnd = (): void => {
			cleanup();
			try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
			catch { reject(new HeadlessError("prompt_invalid_utf8", 2)); }
		};
		const onError = (): void => { fail(new HeadlessError("stdin_read_failed", 2)); };
		const onClose = (): void => { fail(new HeadlessError("stdin_closed", 2)); };
		const onAbort = (): void => { fail(signal.reason); };
		input.on("data", onData).once("end", onEnd).once("error", onError).once("close", onClose);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

export async function writeFinalMessage(path: string, text: string): Promise<void> {
	if (Buffer.byteLength(text) > MAX_FINAL_BYTES) throw new HeadlessError("output_too_large");
	const temporary = join(dirname(path), `.mycli-output-${randomUUID()}.tmp`);
	try {
		const file = await open(temporary, "wx", 0o600);
		try { await file.writeFile(text.endsWith("\n") ? text : `${text}\n`, "utf8"); await file.sync(); }
		finally { await file.close(); }
		await rename(temporary, path);
	} catch {
		throw new HeadlessError("output_write_failed");
	} finally {
		await rm(temporary, { force: true });
	}
}

import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";

export const DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS = 2_000;
export const DEFAULT_SHELL_MODEL_OUTPUT_MAX_TOKENS = Math.floor(
	DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS / 4,
);
export const SHELL_MODEL_OUTPUT_MAX_TOKENS = Math.floor(TOOL_RESULT_OUTPUT_MAX_CHARS / 4);

export interface ShellResultInput {
	readonly chunkId: string;
	readonly wallTimeSeconds: number;
	readonly shellId: string;
	readonly terminalState?: string | null;
	readonly exitCode?: number | null;
	readonly output: string;
	readonly maxOutputTokens: number;
}

export interface FormattedShellResult {
	readonly modelOutput: string;
	readonly originalTokenCount: number;
	readonly originalChars: number;
	readonly retainedChars: number;
	readonly omittedChars: number;
}

export function formatShellResult(input: ShellResultInput): FormattedShellResult {
	const chunkId = nonEmptyBounded(input.chunkId, "chunkId", 128);
	const shellId = nonEmptyBounded(input.shellId, "shellId", 256);
	if (!Number.isFinite(input.wallTimeSeconds) || input.wallTimeSeconds < 0) {
		throw new RangeError("wallTimeSeconds must be a non-negative finite number");
	}
	if (!Number.isSafeInteger(input.maxOutputTokens)
		|| input.maxOutputTokens <= 0
		|| input.maxOutputTokens > Math.floor(Number.MAX_SAFE_INTEGER / 4)) {
		throw new RangeError("maxOutputTokens must be a positive safe integer");
	}
	if (input.exitCode !== undefined
		&& input.exitCode !== null
		&& !Number.isSafeInteger(input.exitCode)) {
		throw new RangeError("exitCode must be a safe integer when supplied");
	}

	const running = input.terminalState === undefined || input.terminalState === null;
	const status = running
		? `Process running with session ID ${shellId}`
		: `Process exited with code ${input.exitCode ?? -1}`;
	const heading = running ? "Live output:" : "Final output:";
	const statusLines = [
		`Chunk ID: ${chunkId}`,
		`Wall time: ${input.wallTimeSeconds.toFixed(2)} seconds`,
		status,
		heading,
	];
	const statusText = statusLines.join("\n");
	const original = input.output ? `${statusText}\n${input.output}` : statusText;
	const originalTokenCount = Math.ceil(original.length / 4);
	// The fixed status lines stay outside the truncation budget so the exit code and session id can
	// never be trimmed away; the budget applies to the command output only.
	const outputBudget = Math.max(0, input.maxOutputTokens * 4 - statusText.length - 1);
	const bounded = headTail(input.output, outputBudget, originalTokenCount);
	const modelOutput = !input.output
		? statusText
		: outputBudget === 0
			? `${statusText}\n[output omitted; original ~${originalTokenCount} tokens]`
			: `${statusText}\n${bounded.text}`;
	const retainedOutputChars = outputBudget === 0 ? 0 : bounded.retainedChars;
	return Object.freeze({
		modelOutput,
		originalTokenCount,
		originalChars: original.length,
		retainedChars: statusText.length + (input.output ? 1 + retainedOutputChars : 0),
		omittedChars: original.length - (statusText.length + (input.output ? 1 + retainedOutputChars : 0)),
	});
}

interface BoundedText {
	readonly text: string;
	readonly retainedChars: number;
}

function headTail(value: string, maxChars: number, originalTokenCount: number): BoundedText {
	if (value.length <= maxChars) return { text: value, retainedChars: value.length };
	if (maxChars === 0) return { text: "", retainedChars: 0 };

	const fullMarker = omissionMarker(value.length, originalTokenCount);
	const compactMarker = "[chars omitted]";
	const marker = maxChars - fullMarker.length >= 2
		? stableCountedMarker(value.length, maxChars, originalTokenCount)
		: maxChars - compactMarker.length >= 2
			? compactMarker
			: ".".slice(0, maxChars);
	const contentBudget = Math.max(0, maxChars - marker.length);
	const headChars = Math.ceil(contentBudget / 2);
	const tailChars = contentBudget - headChars;
	const tail = tailChars === 0 ? "" : value.slice(-tailChars);
	return {
		text: `${value.slice(0, headChars)}${marker}${tail}`,
		retainedChars: headChars + tailChars,
	};
}

function stableCountedMarker(originalChars: number, maxChars: number, originalTokenCount: number): string {
	let omittedChars = originalChars;
	for (let iteration = 0; iteration < 4; iteration += 1) {
		const marker = omissionMarker(omittedChars, originalTokenCount);
		const retainedChars = Math.max(0, maxChars - marker.length);
		const nextOmitted = originalChars - retainedChars;
		if (nextOmitted === omittedChars) return marker;
		omittedChars = nextOmitted;
	}
	return omissionMarker(omittedChars, originalTokenCount);
}

function omissionMarker(omittedChars: number, originalTokenCount: number): string {
	return `\n... [${omittedChars} chars omitted; original ~${originalTokenCount} tokens] ...\n`;
}

function nonEmptyBounded(value: string, name: string, maxChars: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maxChars) {
		throw new RangeError(`${name} must contain between 1 and ${maxChars} characters`);
	}
	return normalized;
}

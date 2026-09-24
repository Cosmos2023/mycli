import {
	TOOL_RESULT_OUTPUT_MAX_CHARS,
	type CanonicalToolResult,
} from "@mycli/core";
import type { ToolExecutionResult } from "@mycli/tools";

/**
 * Central model-output budget. Every tool result is recorded as a canonical conversation item, and
 * the storage layer rejects anything above {@link TOOL_RESULT_OUTPUT_MAX_CHARS}. Tools are expected
 * to shape their own output, but this layer is the backstop that turns an oversized result into a
 * truncated one instead of failing the turn.
 */
export const MODEL_OUTPUT_MAX_CHARS = TOOL_RESULT_OUTPUT_MAX_CHARS;

/** Codex estimates tokens as UTF-8 bytes over four; keep the same unit for budget accounting. */
export const MODEL_OUTPUT_BYTES_PER_TOKEN = 4;

/** Floor for a configured budget so a tiny setting still leaves a readable result. */
export const MODEL_OUTPUT_MIN_CHARS = 256;

export interface BoundedModelOutput {
	readonly text: string;
	readonly truncated: boolean;
	readonly originalChars: number;
	readonly originalTokens: number;
	readonly totalLines: number;
}

export function approxModelOutputTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.ceil(Buffer.byteLength(text, "utf8") / MODEL_OUTPUT_BYTES_PER_TOKEN);
}

/**
 * Resolves `context.compression_threshold_tokens` into the character budget for one model-visible
 * tool result. The token threshold is converted with the same four-bytes-per-token estimate Codex
 * uses and clamped to the storage invariant, so the documented setting actually bounds results.
 */
export function modelOutputMaxCharsFromTokens(tokens: number | undefined): number {
	if (tokens === undefined || !Number.isSafeInteger(tokens) || tokens <= 0) {
		return MODEL_OUTPUT_MAX_CHARS;
	}
	return Math.min(
		MODEL_OUTPUT_MAX_CHARS,
		Math.max(MODEL_OUTPUT_MIN_CHARS, tokens * MODEL_OUTPUT_BYTES_PER_TOKEN),
	);
}

/**
 * Bounds one model-visible tool output. Oversized text keeps its head and tail, drops the middle,
 * and says how much was dropped plus the original token and line counts, mirroring Codex's
 * `Warning: truncated output (original token count: N)` header. The returned text never exceeds
 * `maxChars` characters and never splits a surrogate pair.
 */
export function boundModelOutput(
	text: string,
	maxChars = MODEL_OUTPUT_MAX_CHARS,
): BoundedModelOutput {
	const originalChars = text.length;
	const originalTokens = approxModelOutputTokens(text);
	const totalLines = text.length === 0 ? 0 : text.split("\n").length;
	if (originalChars <= maxChars) {
		return { text, truncated: false, originalChars, originalTokens, totalLines };
	}

	const header = `Warning: truncated output (original token count: ${originalTokens})\n`
		+ `Total output lines: ${totalLines}\n\n`;
	// The marker quotes the number of dropped characters and trimming a split surrogate pair removes
	// one more, so settle the exact body length by measuring the assembled text instead of predicting
	// it. Each attempt shrinks the budget, so the loop terminates and the result fits.
	let bodyBudget = Math.max(0, maxChars - header.length - omittedMarker(originalChars).length);
	let bounded = header.slice(0, maxChars);
	for (let attempt = 0; attempt < 3 && bodyBudget >= 2; attempt += 1) {
		const headChars = Math.floor(bodyBudget / 2);
		const head = safeHead(text, headChars);
		const tail = safeTail(text, bodyBudget - headChars);
		const candidate = `${header}${head}${omittedMarker(originalChars - head.length - tail.length)}${tail}`;
		bounded = candidate;
		if (candidate.length <= maxChars) break;
		bodyBudget -= Math.max(1, candidate.length - maxChars);
	}
	return {
		text: bounded,
		truncated: true,
		originalChars,
		originalTokens,
		totalLines,
	};
}

/**
 * Projects one tool execution into the canonical conversation item. Images and tool discoveries are
 * carried through untouched; only the text body is bounded.
 */
export function canonicalToolResult(
	result: ToolExecutionResult,
	maxChars = MODEL_OUTPUT_MAX_CHARS,
): CanonicalToolResult {
	return {
		callId: result.callId,
		toolName: result.toolName,
		output: boundModelOutput(result.modelOutput, maxChars).text,
		...(result.images?.length ? { images: result.images } : {}),
		success: result.success,
	};
}

function omittedMarker(removedChars: number): string {
	return `…${removedChars} chars truncated…`;
}

function safeHead(text: string, chars: number): string {
	if (chars <= 0) return "";
	const head = text.slice(0, chars);
	const last = head.charCodeAt(head.length - 1);
	// Drop a dangling high surrogate so the head never ends with half of an astral character.
	return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

function safeTail(text: string, chars: number): string {
	if (chars <= 0) return "";
	const tail = text.slice(-chars);
	const first = tail.charCodeAt(0);
	// Drop a dangling low surrogate so the tail never starts with half of an astral character.
	return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

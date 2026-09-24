import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";

export interface TokenEncoder {
	encode(text: string): readonly number[];
}

/**
 * Longest window handed to a single encoder call while counting in windows.
 *
 * Both JavaScript BPE implementations merge one pre-tokenizer piece in
 * quadratic time, so a piece of a few thousand characters - a CJK paragraph
 * without punctuation, a long separator line - blocks the event loop for
 * seconds. Cutting the text into windows bounds how large such a piece can get.
 */
export const TOKEN_COUNT_WINDOW_CHARS = 128;

/**
 * Merge work a single encoder call may perform, in squared UTF-8 bytes. The
 * merge loop walks every adjacent pair of a piece, so its cost grows with the
 * square of the piece: measured on this encoder, one call costs about
 * 6e-5 ms per squared byte, which makes this limit roughly 100 ms. Text under
 * the limit is counted in one exact call; text above it is counted in windows.
 */
const EXACT_MERGE_WORK_LIMIT = 1_700_000;

export interface TokenCounterOptions {
	readonly maxCache?: number;
	readonly loadEncoder?: () => TokenEncoder;
}

export class TokenCounter {
	readonly #loadEncoder: () => TokenEncoder;
	readonly #maxCache: number;
	readonly #cache = new Map<string, number>();
	#encoder: TokenEncoder | undefined;
	#encoderLoaded = false;

	constructor(options: TokenCounterOptions = {}) {
		this.#maxCache = cacheBound(options.maxCache ?? 10_000);
		this.#loadEncoder = options.loadEncoder ?? (() => {
			const encoder = getEncoding("o200k_base");
			// Conversation text can quote tokenizer markers. Count them as ordinary
			// content instead of rejecting them or interpreting them as control tokens.
			return { encode: (text: string): readonly number[] => encoder.encode(text, [], []) };
		});
	}

	count(text: string): number {
		if (!text) return 0;
		const key = createHash("sha256").update(text, "utf8").digest("hex");
		const cached = this.#cache.get(key);
		if (cached !== undefined) {
			this.#cache.delete(key);
			this.#cache.set(key, cached);
			return cached;
		}
		const encoder = this.#resolveEncoder();
		const tokens = encoder
			? encoderCount(encoder, text)
			: fallbackTokenEstimate(text);
		if (this.#maxCache > 0) {
			this.#cache.set(key, tokens);
			if (this.#cache.size > this.#maxCache) {
				const oldest = this.#cache.keys().next().value as string | undefined;
				if (oldest !== undefined) this.#cache.delete(oldest);
			}
		}
		return tokens;
	}

	#resolveEncoder(): TokenEncoder | undefined {
		if (this.#encoderLoaded) return this.#encoder;
		this.#encoderLoaded = true;
		try {
			this.#encoder = this.#loadEncoder();
		} catch {
			this.#encoder = undefined;
		}
		return this.#encoder;
	}
}

function encoderCount(encoder: TokenEncoder, text: string): number {
	const work = mergeWork(text);
	// Windowing only pays off when a piece is far longer than a window. Text
	// whose cost comes from many short pieces costs the same either way, so it
	// keeps the exact single call instead of trading accuracy for nothing.
	if (work.direct <= EXACT_MERGE_WORK_LIMIT || work.windowed * 2 > work.direct) {
		return encoder.encode(text).length;
	}
	let tokens = 0;
	for (const window of encodeWindows(text)) {
		tokens += encoder.encode(window).length;
	}
	return tokens;
}

interface MergeWork {
	/** Estimated cost of handing the whole text to one encoder call. */
	readonly direct: number;
	/** The same text counted in windows of `TOKEN_COUNT_WINDOW_CHARS` characters. */
	readonly windowed: number;
}

/**
 * Estimated merge work, in squared UTF-8 bytes, for counting the text in one
 * call and for counting it in windows.
 *
 * A pre-tokenizer piece is one run of letters, one run of digits, one run of
 * punctuation or one run of whitespace, so the runs below approximate the
 * pieces the encoder will build. Digit runs count as pieces of three characters
 * because the pattern splits them that way, and the two spare bytes per run
 * cover the characters the pattern may absorb from a neighbouring run.
 */
function mergeWork(text: string): MergeWork {
	let direct = 0;
	let windowed = 0;
	let kind = CHARACTER_NONE;
	let runBytes = 0;
	let runChars = 0;
	for (let index = 0; index < text.length;) {
		const code = text.charCodeAt(index);
		const paired = isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1));
		const width = paired ? 2 : 1;
		const next = characterKind(text, index, width);
		const bytes = paired ? 4 : utf8Width(code);
		if (next === kind) {
			runBytes += bytes;
			runChars += 1;
		} else {
			direct += directRunWork(kind, runBytes);
			windowed += windowedRunWork(kind, runBytes, runChars);
			// Windowing can already be ruled out: every further run keeps the
			// windowed estimate below half of the direct one.
			if (direct > EXACT_MERGE_WORK_LIMIT && windowed * 2 <= direct) {
				return { direct, windowed };
			}
			kind = next;
			runBytes = bytes;
			runChars = 1;
		}
		index += width;
	}
	return {
		direct: direct + directRunWork(kind, runBytes),
		windowed: windowed + windowedRunWork(kind, runBytes, runChars),
	};
}

function directRunWork(kind: number, runBytes: number): number {
	if (kind === CHARACTER_NONE) return 0;
	// The pattern emits a digit run as pieces of at most three characters, so a
	// long number stays cheap and must not push the text into windowing.
	if (kind === CHARACTER_NUMBER) return Math.ceil(runBytes / 3) * 25;
	return (runBytes + 2) ** 2;
}

function windowedRunWork(kind: number, runBytes: number, runChars: number): number {
	if (kind === CHARACTER_NONE) return 0;
	if (kind === CHARACTER_NUMBER) return Math.ceil(runBytes / 3) * 25;
	const windows = Math.ceil(runChars / TOKEN_COUNT_WINDOW_CHARS);
	return windows * (Math.ceil(runBytes / windows) + 2) ** 2;
}

const CHARACTER_NONE = 0;
const CHARACTER_WHITESPACE = 1;
const CHARACTER_LETTER = 2;
const CHARACTER_NUMBER = 3;
const CHARACTER_OTHER = 4;

const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const NUMBER = /\p{N}/u;

function characterKind(text: string, index: number, width: number): number {
	const code = text.charCodeAt(index);
	if (code < 0x80) {
		if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return CHARACTER_WHITESPACE;
		if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return CHARACTER_LETTER;
		if (code >= 0x30 && code <= 0x39) return CHARACTER_NUMBER;
		return CHARACTER_OTHER;
	}
	const character = text.slice(index, index + width);
	if (NON_ASCII_WHITESPACE.test(character)) return CHARACTER_WHITESPACE;
	if (LETTER_OR_MARK.test(character)) return CHARACTER_LETTER;
	if (NUMBER.test(character)) return CHARACTER_NUMBER;
	return CHARACTER_OTHER;
}

function utf8Width(code: number): number {
	if (code < 0x80) return 1;
	if (code < 0x800) return 2;
	return 3;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function* encodeWindows(text: string): Generator<string> {
	let start = 0;
	while (start < text.length) {
		const end = windowEnd(text, start);
		yield text.slice(start, end);
		start = end;
	}
}

function windowEnd(text: string, start: number): number {
	const limit = Math.min(start + TOKEN_COUNT_WINDOW_CHARS, text.length);
	if (limit >= text.length) return text.length;

	// Cut where the pattern already breaks, so both windows tokenize the way the
	// whole text does and ordinary text keeps its exact count. The search walks
	// back to the start of the window and takes the first boundary it finds, so
	// windows stay near the limit unless the text has nothing breakable inside.
	for (let index = limit; index > start; index -= 1) {
		if (isPieceBoundary(text, index)) return index;
	}

	// Nothing breakable inside the window: cut at the limit without splitting a
	// surrogate pair, which would turn one astral character into two replacements.
	const paired = isHighSurrogate(text.charCodeAt(limit - 1)) && isLowSurrogate(text.charCodeAt(limit));
	return paired ? limit - 1 : limit;
}

/**
 * True when the encoder would start a new piece at `index` even if the text
 * before it were gone. Whitespace other than a newline never binds backwards,
 * while a newline is absorbed by the punctuation run in front of it, so that
 * cut belongs after the last newline of the run.
 */
function isPieceBoundary(text: string, index: number): boolean {
	const before = text.charCodeAt(index - 1);
	const at = text.charCodeAt(index);
	if (isNewlineCode(at)) return false;
	if (isWhitespaceCode(before, text[index - 1]!)) return isNewlineCode(before) && at !== SLASH;
	return isWhitespaceCode(at, text[index]!);
}

const SLASH = 0x2f;

function isNewlineCode(code: number): boolean {
	return code === 0x0a || code === 0x0d;
}

function isWhitespaceCode(code: number, character: string): boolean {
	if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
	if (code < 0x80 || Number.isNaN(code)) return false;
	// Mirror the encoder's own `\s`, which includes U+FEFF, U+00A0 and U+3000.
	return NON_ASCII_WHITESPACE.test(character);
}

const NON_ASCII_WHITESPACE = /\s/u;

export function fallbackTokenEstimate(text: string): number {
	if (!text) return 0;
	let asciiChars = 0;
	let totalChars = 0;
	for (const char of text) {
		totalChars += 1;
		if (char.codePointAt(0)! <= 127) asciiChars += 1;
	}
	return Math.max(1, Math.ceil(asciiChars / 4) + totalChars - asciiChars);
}

function cacheBound(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError("maxCache must be a non-negative safe integer");
	}
	return value;
}

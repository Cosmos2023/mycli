import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";

export interface TokenEncoder {
	encode(text: string): readonly number[];
}

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
			? encoder.encode(text).length
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

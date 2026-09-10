export interface ShellOutputRead {
	readonly text: string;
	readonly nextCursor: number;
	readonly outputChars: number;
	readonly omittedChars: number;
	readonly cursorWasEvicted: boolean;
}

export class ShellOutputBuffer {
	readonly #maxChars: number;
	#retained = "";
	#startCursor = 0;
	#totalChars = 0;

	constructor(options: { readonly maxChars: number }) {
		if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0) {
			throw new RangeError("maxChars must be a non-negative safe integer");
		}
		this.#maxChars = options.maxChars;
	}

	append(text: string): void {
		if (!text) return;
		this.#totalChars += text.length;
		if (this.#maxChars === 0) {
			this.#retained = "";
			this.#startCursor = this.#totalChars;
			return;
		}
		const combined = this.#retained + text;
		this.#retained = combined.length <= this.#maxChars
			? combined
			: combined.slice(-this.#maxChars);
		this.#startCursor = this.#totalChars - this.#retained.length;
	}

	read(cursor: number): ShellOutputRead {
		if (!Number.isSafeInteger(cursor) || cursor < 0) {
			throw new RangeError("cursor must be a non-negative safe integer");
		}
		const effectiveCursor = Math.min(cursor, this.#totalChars);
		const omittedChars = Math.max(0, this.#startCursor - effectiveCursor);
		const retainedOffset = Math.max(0, effectiveCursor - this.#startCursor);
		return Object.freeze({
			text: this.#retained.slice(retainedOffset),
			nextCursor: this.#totalChars,
			outputChars: this.#totalChars,
			omittedChars,
			cursorWasEvicted: omittedChars > 0,
		});
	}

	retained(): string {
		return this.#retained;
	}
}

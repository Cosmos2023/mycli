export interface NormalizedOutput {
	readonly text: string;
	readonly replacementCount: number;
	/** Decoding used for this output; `fallback` means the UTF-8 attempt failed. */
	readonly encoding?: "utf-8" | "fallback";
}

export interface TerminalOutputNormalizerOptions {
	/**
	 * Console code page used when a Windows child ignores UTF-8 and emits the
	 * legacy ANSI/OEM encoding (for example `cmd.exe` before `chcp 65001`).
	 * Leave unset to keep the historical replacement-character behavior; the
	 * Shell session manager enables it for Windows console children.
	 */
	readonly fallbackEncoding?: string;
}

type EscapeState =
	| "text"
	| "escape"
	| "csi"
	| "osc"
	| "osc_escape"
	| "control_string"
	| "control_string_escape";

export class TerminalOutputNormalizer {
	readonly #decoder: TextDecoder;
	readonly #fallback: TextDecoder | undefined;
	#encoding: NormalizedOutput["encoding"] = "utf-8";
	#escapeState: EscapeState = "text";
	#pendingCarriageReturn = false;
	#finished = false;

	constructor(options: TerminalOutputNormalizerOptions = {}) {
		const fallback = options.fallbackEncoding;
		this.#fallback = fallback === undefined ? undefined : new TextDecoder(fallback, { fatal: false });
		// Fatal decoding only makes sense when a console-code-page fallback exists;
		// otherwise keep the historical replacement-character behavior.
		this.#decoder = new TextDecoder("utf-8", { fatal: this.#fallback !== undefined });
	}

	push(chunk: Uint8Array | string): NormalizedOutput {
		if (this.#finished) {
			throw new Error("terminal output normalizer is already finished");
		}
		if (typeof chunk === "string") {
			return this.#withEncoding(this.#normalize(chunk));
		}
		const { text, encoding } = this.#decodeBytes(chunk, true);
		return this.#withEncoding(this.#normalize(text), encoding);
	}

	finish(): NormalizedOutput {
		if (this.#finished) return EMPTY_OUTPUT;
		this.#finished = true;
		const decoded = this.#encoding === "fallback"
			? this.#fallback?.decode() ?? ""
			: this.#decodeBytes(new Uint8Array(), false).text;
		const normalized = this.#normalize(decoded);
		const text = this.#pendingCarriageReturn ? `${normalized.text}\n` : normalized.text;
		this.#pendingCarriageReturn = false;
		this.#escapeState = "text";
		return this.#withEncoding(
			{ text, replacementCount: normalized.replacementCount },
			this.#encoding,
		);
	}

	#withEncoding(
		output: NormalizedOutput,
		encoding: NormalizedOutput["encoding"] = this.#encoding,
	): NormalizedOutput {
		return Object.freeze(encoding === "fallback" ? { ...output, encoding } : output);
	}

	#decodeBytes(chunk: Uint8Array, stream: boolean): { readonly text: string; readonly encoding: NonNullable<NormalizedOutput["encoding"]> } {
		if (this.#encoding === "fallback") {
			return { text: this.#fallback?.decode(chunk, { stream }) ?? "", encoding: "fallback" };
		}
		try {
			return { text: this.#decoder.decode(chunk, { stream }), encoding: "utf-8" };
		} catch {
			// The child emitted its console code page instead of UTF-8. Switch the
			// whole stream to the fallback decoder; resetting the UTF-8 decoder
			// drops any half-decoded sequence it kept from earlier chunks.
			if (this.#fallback === undefined) throw new Error("terminal output is not valid UTF-8");
			this.#decoder.decode();
			this.#encoding = "fallback";
			return { text: this.#fallback.decode(chunk, { stream }), encoding: "fallback" };
		}
	}

	#normalize(decoded: string): NormalizedOutput {
		const output: string[] = [];
		for (const character of decoded) {
			this.#consume(character, output);
		}
		return Object.freeze({
			text: output.join(""),
			replacementCount: countReplacements(decoded),
		});
	}

	#consume(character: string, output: string[]): void {
		if (this.#consumeEscape(character)) return;

		if (this.#pendingCarriageReturn) {
			output.push("\n");
			this.#pendingCarriageReturn = false;
			if (character === "\n") return;
		}

		if (character === "\x1b") {
			this.#escapeState = "escape";
			return;
		}
		if (character === "\u009b") {
			this.#escapeState = "csi";
			return;
		}
		if (character === "\u009d") {
			this.#escapeState = "osc";
			return;
		}
		if (["\u0090", "\u0098", "\u009e", "\u009f"].includes(character)) {
			this.#escapeState = "control_string";
			return;
		}
		if (character === "\r") {
			this.#pendingCarriageReturn = true;
			return;
		}
		if (character === "\b") {
			if (output.length > 0 && !["\n", "\t"].includes(output.at(-1) ?? "")) {
				output.pop();
			}
			return;
		}
		const codePoint = character.codePointAt(0) ?? 0;
		if ((codePoint < 32 && character !== "\n" && character !== "\t")
			|| (codePoint >= 127 && codePoint <= 159)) {
			return;
		}
		output.push(character);
	}

	#consumeEscape(character: string): boolean {
		switch (this.#escapeState) {
			case "text":
				return false;
			case "escape":
				if (character === "[") this.#escapeState = "csi";
				else if (character === "]") this.#escapeState = "osc";
				else if (["P", "X", "^", "_"].includes(character)) {
					this.#escapeState = "control_string";
				} else if (character !== "\x1b") this.#escapeState = "text";
				return true;
			case "csi":
				if (character === "\x1b") this.#escapeState = "escape";
				else if (character >= "@" && character <= "~") this.#escapeState = "text";
				return true;
			case "osc":
				if (character === "\x07" || character === "\u009c") this.#escapeState = "text";
				else if (character === "\x1b") this.#escapeState = "osc_escape";
				return true;
			case "osc_escape":
				this.#escapeState = character === "\\" ? "text" : "osc";
				return true;
			case "control_string":
				if (character === "\u009c") this.#escapeState = "text";
				else if (character === "\x1b") this.#escapeState = "control_string_escape";
				return true;
			case "control_string_escape":
				this.#escapeState = character === "\\" ? "text" : "control_string";
				return true;
		}
	}
}

const EMPTY_OUTPUT: NormalizedOutput = Object.freeze({ text: "", replacementCount: 0 });

function countReplacements(value: string): number {
	let count = 0;
	for (const character of value) {
		if (character === "�") count += 1;
	}
	return count;
}

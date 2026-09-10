export interface NormalizedOutput {
	readonly text: string;
	readonly replacementCount: number;
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
	readonly #decoder = new TextDecoder("utf-8", { fatal: false });
	#escapeState: EscapeState = "text";
	#pendingCarriageReturn = false;
	#finished = false;

	push(chunk: Uint8Array | string): NormalizedOutput {
		if (this.#finished) {
			throw new Error("terminal output normalizer is already finished");
		}
		const decoded = typeof chunk === "string"
			? chunk
			: this.#decoder.decode(chunk, { stream: true });
		return this.#normalize(decoded);
	}

	finish(): NormalizedOutput {
		if (this.#finished) return EMPTY_OUTPUT;
		this.#finished = true;
		const decoded = this.#decoder.decode();
		const normalized = this.#normalize(decoded);
		const text = this.#pendingCarriageReturn ? `${normalized.text}\n` : normalized.text;
		this.#pendingCarriageReturn = false;
		this.#escapeState = "text";
		return Object.freeze({ text, replacementCount: normalized.replacementCount });
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

const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";

interface ProposedPlanExtraction {
	readonly assistantText: string;
	readonly planText: string;
}

interface TextLine {
	readonly start: number;
	readonly end: number;
	readonly content: string;
}

export function extractProposedPlan(text: string): ProposedPlanExtraction | undefined {
	const lines = textLines(text);
	const openings = lines.filter((line) => line.content === OPEN_TAG);
	const closings = lines.filter((line) => line.content === CLOSE_TAG);
	if (openings.length !== 1 || closings.length !== 1) return undefined;

	const opening = openings[0]!;
	const closing = closings[0]!;
	if (closing.start <= opening.start) return undefined;
	const planText = text.slice(opening.end, closing.start).trim();
	if (!planText) return undefined;

	return Object.freeze({
		assistantText: `${text.slice(0, opening.start)}${text.slice(closing.end)}`.trim(),
		planText,
	});
}

export class ProposedPlanStreamFilter {
	#buffer = "";
	#hidden = "";
	#insidePlan = false;
	#atLineStart = true;
	#passthrough = false;

	push(text: string): string {
		if (!text) return "";
		if (this.#passthrough) return text;
		this.#buffer += text;
		let visible = "";

		while (this.#buffer) {
			if (this.#insidePlan) {
				const newline = this.#buffer.indexOf("\n");
				if (newline < 0) break;
				const line = this.#buffer.slice(0, newline + 1);
				this.#buffer = this.#buffer.slice(newline + 1);
				if (lineContent(line) === CLOSE_TAG) {
					this.#hidden = "";
					this.#insidePlan = false;
					this.#atLineStart = true;
					this.#passthrough = true;
					visible += this.#buffer;
					this.#buffer = "";
					break;
				}
				this.#hidden += line;
				continue;
			}

			if (!this.#atLineStart) {
				const newline = this.#buffer.indexOf("\n");
				if (newline < 0) {
					visible += this.#buffer;
					this.#buffer = "";
					break;
				}
				visible += this.#buffer.slice(0, newline + 1);
				this.#buffer = this.#buffer.slice(newline + 1);
				this.#atLineStart = true;
				continue;
			}

			const newline = this.#buffer.indexOf("\n");
			if (newline >= 0) {
				const line = this.#buffer.slice(0, newline + 1);
				this.#buffer = this.#buffer.slice(newline + 1);
				if (lineContent(line) === OPEN_TAG) {
					this.#insidePlan = true;
					this.#hidden = line;
					continue;
				}
				visible += line;
				continue;
			}

			const candidate = this.#buffer.endsWith("\r")
				? this.#buffer.slice(0, -1)
				: this.#buffer;
			if (OPEN_TAG.startsWith(candidate)) break;
			visible += this.#buffer;
			this.#buffer = "";
			this.#atLineStart = false;
		}

		return visible;
	}

	finishSegment(): string {
		let visible = "";
		if (this.#insidePlan) {
			if (lineContent(this.#buffer) !== CLOSE_TAG) {
				visible = `${this.#hidden}${this.#buffer}`;
			}
		} else {
			visible = this.#buffer;
		}
		this.reset();
		return visible;
	}

	reset(): void {
		this.#buffer = "";
		this.#hidden = "";
		this.#insidePlan = false;
		this.#atLineStart = true;
		this.#passthrough = false;
	}
}

function textLines(text: string): readonly TextLine[] {
	const lines: TextLine[] = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		const contentEnd = newline < 0 ? text.length : newline;
		const rawContent = text.slice(start, contentEnd);
		lines.push(Object.freeze({
			start,
			end: newline < 0 ? text.length : newline + 1,
			content: rawContent.endsWith("\r") ? rawContent.slice(0, -1) : rawContent,
		}));
		if (newline < 0) break;
		start = newline + 1;
	}
	return Object.freeze(lines);
}

function lineContent(line: string): string {
	return line.replace(/\r?\n$/u, "").replace(/\r$/u, "");
}

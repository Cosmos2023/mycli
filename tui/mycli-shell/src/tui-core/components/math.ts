/**
 * Bounded Unicode layout for a small TeX subset.
 *
 * Display math is laid out on multiple rows; inline math stays on one line so it can
 * join ordinary paragraph text. Anything outside the supported subset returns
 * `undefined` so callers keep the original source instead of rendering it wrongly.
 */

export const MAX_MATH_BYTES = 4_096;
const MAX_ROWS = 16;
const MAX_COLUMNS = 256;
const MAX_DEPTH = 32;

interface Layout {
	readonly rows: readonly string[];
	readonly baseline: number;
}

const GREEK: Readonly<Record<string, string>> = {
	alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
	zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", varkappa: "ϰ",
	lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ",
	rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
	phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
	Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
	Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const SYMBOLS: Readonly<Record<string, string>> = {
	pm: "±", mp: "∓", times: "×", div: "÷", cdot: "·", ast: "∗", star: "⋆",
	le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", equiv: "≡", approx: "≈",
	sim: "∼", simeq: "≃", propto: "∝", ll: "≪", gg: "≫", lesssim: "≲", gtrsim: "≳",
	in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇",
	cap: "∩", cup: "∪", setminus: "∖", emptyset: "∅", varnothing: "∅",
	forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬",
	land: "∧", wedge: "∧", lor: "∨", vee: "∨", oplus: "⊕", otimes: "⊗", odot: "⊙",
	perp: "⊥", parallel: "∥", angle: "∠", nabla: "∇", partial: "∂",
	infty: "∞", aleph: "ℵ", hbar: "ℏ", ell: "ℓ", imath: "ı", jmath: "ȷ",
	prime: "′", circ: "∘", bullet: "•", dagger: "†", ddagger: "‡",
	mid: "|", colon: ":", therefore: "∴", because: "∵", square: "□", triangle: "△", deg: "°",
	to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", mapsto: "↦",
	Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⟹", impliedby: "⟸", iff: "⟺",
	uparrow: "↑", downarrow: "↓", updownarrow: "↕",
	ldots: "…", cdots: "⋯", dots: "…", vdots: "⋮", ddots: "⋱",
	sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
	bigcup: "⋃", bigcap: "⋂", bigwedge: "⋀", sqrt: "√",
	langle: "⟨", rangle: "⟩", lbrace: "{", rbrace: "}", lbrack: "[", rbrack: "]",
	lvert: "|", rvert: "|", lVert: "‖", rVert: "‖", vert: "|", Vert: "‖",
	lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
	quad: "  ", qquad: "    ", ",": " ", ";": " ", ":": " ", "!": "",
	" ": " ", "%": "%", "&": "&", "#": "#", "$": "$", "{": "{", "}": "}", "_": "_",
};

const FUNCTIONS = new Set([
	"sin", "cos", "tan", "log", "ln", "exp", "min", "max", "lim", "det", "gcd", "sup", "inf",
]);

const BIG_OPERATORS = new Set(["sum", "prod", "coprod", "int", "iint", "iiint", "oint", "bigcup", "bigcap", "bigwedge"]);

const FONT_COMMANDS: Readonly<Record<string, (text: string) => string>> = {
	mathbb: blackboard,
	mathbf: upperCase,
	mathcal: upperCase,
	mathit: (text) => text,
	mathrm: (text) => text,
	operatorname: (text) => text,
	text: (text) => text,
};

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
	"0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
	"+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ",
};

const SUBSCRIPTS: Readonly<Record<string, string>> = {
	"0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
	"+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
	a: "ₐ", e: "ₑ", o: "ₒ", x: "ₓ", h: "ₕ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", p: "ₚ", s: "ₛ", t: "ₜ",
};

function upperCase(text: string): string {
	return text.toUpperCase();
}

const BLACKBOARD: Readonly<Record<string, string>> = {
	C: "ℂ", E: "𝔼", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ",
};

function blackboard(text: string): string {
	return [...text].map((character) => BLACKBOARD[character.toUpperCase()] ?? character.toUpperCase()).join("");
}

function width(value: string): number {
	let total = 0;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		total += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf)
			|| (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
			|| (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
			|| (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f9ff)) ? 2 : 1;
	}
	return total;
}

function text(value: string): Layout {
	return { rows: [value], baseline: 0 };
}

function layoutWidth(layout: Layout): number {
	return layout.rows.reduce((max, row) => Math.max(max, width(row)), 0);
}

function pad(value: string, target: number): string {
	return value + " ".repeat(Math.max(0, target - width(value)));
}

/** Concatenate two layouts on a shared baseline, rejecting unbounded output. */
function join(left: Layout, right: Layout): Layout | undefined {
	const baseline = Math.max(left.baseline, right.baseline);
	const height = Math.max(baseline - left.baseline + left.rows.length, baseline - right.baseline + right.rows.length);
	const leftWidth = layoutWidth(left);
	const totalWidth = leftWidth + layoutWidth(right);
	if (height > MAX_ROWS || totalWidth > MAX_COLUMNS) return undefined;
	const rows: string[] = [];
	for (let index = 0; index < height; index += 1) {
		const leftRow = index - (baseline - left.baseline);
		const rightRow = index - (baseline - right.baseline);
		const leftText = leftRow >= 0 ? left.rows[leftRow] ?? "" : "";
		const rightText = rightRow >= 0 ? right.rows[rightRow] ?? "" : "";
		rows.push(pad(leftText, leftWidth) + rightText);
	}
	return { rows, baseline };
}

function joinAll(parts: readonly Layout[]): Layout | undefined {
	let result = text("");
	for (const part of parts) {
		const next = join(result, part);
		if (!next) return undefined;
		result = next;
	}
	return result;
}

function fraction(numerator: Layout, denominator: Layout): Layout | undefined {
	const barWidth = Math.max(layoutWidth(numerator), layoutWidth(denominator));
	if (numerator.rows.length > 8 || denominator.rows.length > 8 || barWidth > MAX_COLUMNS) return undefined;
	const rows = [
		...numerator.rows.map((row) => center(row, barWidth)),
		"─".repeat(barWidth),
		...denominator.rows.map((row) => center(row, barWidth)),
	];
	return rows.length > MAX_ROWS ? undefined : { rows, baseline: numerator.rows.length };
}

function center(value: string, target: number): string {
	const padding = Math.max(0, target - width(value));
	const left = Math.floor(padding / 2);
	return " ".repeat(left) + value + " ".repeat(padding - left);
}

function radical(inner: Layout): Layout | undefined {
	if (inner.rows.length === 1) {
		const body = inner.rows[0]!;
		return join(text("√"), text([...body].length === 1 ? body : `(${body})`));
	}
	const body = joinAll([text("("), inner, text(")")]);
	return body ? join(text("√"), body) : undefined;
}

function stackSuperscript(base: Layout, superscript: Layout): Layout | undefined {
	const baseWidth = layoutWidth(base);
	const rows = [
		" ".repeat(baseWidth) + superscript.rows[0]!,
		...base.rows.map((row) => pad(row, baseWidth)),
	];
	if (rows.length > MAX_ROWS || rows.some((row) => width(row) > MAX_COLUMNS)) return undefined;
	return { rows, baseline: base.baseline + 1 };
}

function stackSubscript(base: Layout, subscript: Layout): Layout | undefined {
	const baseWidth = layoutWidth(base);
	const rows = [
		...base.rows.map((row) => pad(row, baseWidth)),
		" ".repeat(baseWidth) + subscript.rows[0]!,
	];
	if (rows.length > MAX_ROWS || rows.some((row) => width(row) > MAX_COLUMNS)) return undefined;
	return { rows, baseline: base.baseline };
}

function mapUnicode(value: string, table: Readonly<Record<string, string>>): string | undefined {
	let result = "";
	for (const character of value) {
		const mapped = table[character];
		if (mapped === undefined) return undefined;
		result += mapped;
	}
	return result;
}

/** Inline scripts prefer real Unicode; anything else keeps an explicit `^(...)` form. */
function inlineScript(base: string, superscript?: string, subscript?: string): string {
	let result = base;
	if (subscript !== undefined && subscript !== "") {
		const mapped = mapUnicode(subscript, SUBSCRIPTS);
		result += mapped === undefined ? `_(${subscript})` : mapped;
	}
	if (superscript !== undefined && superscript !== "") {
		const mapped = mapUnicode(superscript, SUPERSCRIPTS);
		result += mapped === undefined ? `^(${superscript})` : mapped;
	}
	return result;
}

function wrapOperand(value: string): string {
	return [...value].length === 1 ? value : `(${value})`;
}

const RELATION_CHARACTERS = "=≠≤≥≈≡∼≃∝∈∉∋⊂⊆⊃⊇→←↔⇒⇐⇔⟹⟸⟺±∓×÷·∗+-";

class MathParser {
	private remaining: string;
	private depth = 0;
	constructor(source: string, private readonly display: boolean) {
		this.remaining = source;
	}

	parse(): Layout | undefined {
		const result = this.sequence(() => this.remaining.length === 0);
		return result && this.remaining.trim().length === 0 ? result : undefined;
	}

	/** Render the parsed tree as a single line for inline use. */
	parseInline(): string | undefined {
		const result = this.sequence(() => this.remaining.length === 0);
		if (!result || this.remaining.trim().length !== 0 || result.rows.length !== 1) return undefined;
		return result.rows[0];
	}

	private sequence(stop: () => boolean): Layout | undefined {
		if (this.depth >= MAX_DEPTH) return undefined;
		this.depth += 1;
		const parts: Layout[] = [];
		try {
			while (this.remaining.length > 0 && !stop()) {
				const next = this.atomWithScripts();
				if (!next) return undefined;
				parts.push(next);
			}
		} finally {
			this.depth -= 1;
		}
		// TeX ignores literal spaces, so interior relations regain them before widths are measured.
		return joinAll(parts.map((part, index) => (
			index > 0 && index < parts.length - 1 && part.rows.length === 1
				&& part.rows[0]!.length === 1 && RELATION_CHARACTERS.includes(part.rows[0]!)
				? text(` ${part.rows[0]!} `)
				: part
		)));
	}

	private atomWithScripts(): Layout | undefined {
		const base = this.atom();
		return base ? this.scripts(base) : undefined;
	}

	private atom(): Layout | undefined {
		this.remaining = this.remaining.replace(/^[ \t]+/u, "");
		const character = this.remaining[0];
		if (character === undefined) return text("");
		if (character === "{") return this.group();
		if (character === "}") return undefined;
		if (character === "\\") return this.command();
		if (character === "^" || character === "_") return undefined;
		this.remaining = this.remaining.slice(character.length);
		return text(character);
	}

	private group(): Layout | undefined {
		this.remaining = this.remaining.slice(1);
		const inner = this.sequence(() => this.remaining.startsWith("}"));
		if (!inner || !this.remaining.startsWith("}")) return undefined;
		this.remaining = this.remaining.slice(1);
		return inner;
	}

	private command(): Layout | undefined {
		this.remaining = this.remaining.slice(1);
		const match = /^[A-Za-z]+/u.exec(this.remaining);
		const name = match ? match[0] : this.remaining[0] ?? "";
		if (name === "") return undefined;
		this.remaining = this.remaining.slice(name.length);
		if (name === "frac" || name === "dfrac" || name === "tfrac") {
			const numerator = this.operand();
			const denominator = this.operand();
			if (!numerator || !denominator) return undefined;
			if (this.display) return fraction(numerator, denominator);
			const top = numerator.rows.length === 1 ? numerator.rows[0] : undefined;
			const bottom = denominator.rows.length === 1 ? denominator.rows[0] : undefined;
			return top === undefined || bottom === undefined ? undefined : text(`${wrapOperand(top)}/${wrapOperand(bottom)}`);
		}
		if (name === "sqrt") return this.radical();
		if (name === "left" || name === "right") return this.delimiter();
		if (name === "boxed") {
			const inner = this.operand();
			return inner ? joinAll([text("["), inner, text("]")]) : undefined;
		}
		const font = FONT_COMMANDS[name];
		if (font) {
			// Text-like commands keep their literal spacing instead of atomizing word by word.
			const inner = this.rawOperand();
			return inner === undefined ? undefined : text(font(inner));
		}
		if (FUNCTIONS.has(name)) {
			const spaced = this.remaining.startsWith("^") || this.remaining.startsWith("_") ? name : `${name} `;
			return this.scripts(text(spaced));
		}
		if (name === "begin" || name === "end" || name === "overset" || name === "underset" || name === "substack") return undefined;
		const symbol = GREEK[name] ?? SYMBOLS[name];
		if (symbol === undefined) return undefined;
		const base = text(symbol);
		// Big operators keep their limits on separate rows for display math.
		if (BIG_OPERATORS.has(name)) return this.bigOperator(base);
		return this.scripts(base);
	}

	private bigOperator(base: Layout): Layout | undefined {
		let subscript: Layout | undefined;
		let superscript: Layout | undefined;
		while (this.remaining.startsWith("_") || this.remaining.startsWith("^")) {
			const marker = this.remaining[0]!;
			this.remaining = this.remaining.slice(1);
			const operand = this.operand();
			if (!operand) return undefined;
			if (marker === "_") subscript = operand;
			else superscript = operand;
		}
		if (!this.display || (subscript === undefined && superscript === undefined)) {
			const inline = inlineScript(base.rows[0]!, superscript?.rows[0], subscript?.rows[0]);
			// Inline limits would otherwise run into the next atom, for example `∑_(i = 1)ⁿi²`.
			return text(subscript === undefined && superscript === undefined ? inline : `${inline} `);
		}
		if ((superscript && superscript.rows.length !== 1) || (subscript && subscript.rows.length !== 1)) return undefined;
		// Limits stay centered on the operator symbol, not on an already stacked layout.
		const operatorWidth = layoutWidth(base);
		const width = Math.max(operatorWidth, superscript ? layoutWidth(superscript) : 0, subscript ? layoutWidth(subscript) : 0);
		const rows: string[] = [];
		if (superscript) rows.push(center(superscript.rows[0]!, width));
		rows.push(...base.rows.map((row) => center(row, width)));
		if (subscript) rows.push(center(subscript.rows[0]!, width));
		if (rows.length > MAX_ROWS || width > MAX_COLUMNS) return undefined;
		return { rows, baseline: superscript ? 1 : 0 };
	}

	private delimiter(): Layout | undefined {
		this.remaining = this.remaining.replace(/^[ \t]+/u, "");
		if (this.remaining.startsWith(".")) {
			this.remaining = this.remaining.slice(1);
			return text("");
		}
		const match = /^\\([A-Za-z]+|[{}[\]|])/u.exec(this.remaining);
		if (match) {
			this.remaining = this.remaining.slice(match[0].length);
			const symbol = GREEK[match[1]!] ?? SYMBOLS[match[1]!] ?? match[1]!;
			return text(symbol);
		}
		const character = this.remaining[0];
		if (character === undefined) return undefined;
		this.remaining = this.remaining.slice(character.length);
		return text(character);
	}

	private radical(): Layout | undefined {
		const inner = this.operand();
		return inner ? radical(inner) : undefined;
	}

	private operand(): Layout | undefined {
		this.remaining = this.remaining.replace(/^[ \t]+/u, "");
		if (this.remaining.startsWith("{")) return this.group();
		const character = this.remaining[0];
		if (character === undefined) return undefined;
		if (character === "\\") return this.command();
		if (character === "^" || character === "_" || character === "}") return undefined;
		this.remaining = this.remaining.slice(character.length);
		return text(character);
	}

	/** Literal `{…}` or single-character operand for text-like commands. */
	private rawOperand(): string | undefined {
		this.remaining = this.remaining.replace(/^[ \t]+/u, "");
		if (this.remaining.startsWith("{")) {
			const end = this.remaining.indexOf("}", 1);
			if (end < 0) return undefined;
			const value = this.remaining.slice(1, end);
			this.remaining = this.remaining.slice(end + 1);
			return value;
		}
		const character = this.remaining[0];
		if (character === undefined || character === "}" || character === "^" || character === "_") return undefined;
		this.remaining = this.remaining.slice(character.length);
		return character;
	}

	private scripts(base: Layout): Layout | undefined {
		let subscript: Layout | undefined;
		let superscript: Layout | undefined;
		for (;;) {
			this.remaining = this.remaining.replace(/^[ \t]+/u, "");
			if (this.remaining.startsWith("_")) {
				this.remaining = this.remaining.slice(1);
				subscript = this.operand();
				if (!subscript) return undefined;
				continue;
			}
			if (this.remaining.startsWith("^")) {
				this.remaining = this.remaining.slice(1);
				superscript = this.operand();
				if (!superscript) return undefined;
				continue;
			}
			break;
		}
		if (!subscript && !superscript) return base;
		if (base.rows.length !== 1 || (subscript && subscript.rows.length !== 1) || (superscript && superscript.rows.length !== 1)) {
			return undefined;
		}
		const baseText = base.rows[0]!;
		const subscriptText = subscript?.rows[0];
		const superscriptText = superscript?.rows[0];
		const compact = inlineScript(baseText, superscriptText, subscriptText);
		// Display math still prefers compact Unicode whenever every script character has a form.
		const representable = (subscriptText === undefined || subscriptText === "" || mapUnicode(subscriptText, SUBSCRIPTS) !== undefined)
			&& (superscriptText === undefined || superscriptText === "" || mapUnicode(superscriptText, SUPERSCRIPTS) !== undefined);
		if (!this.display || representable) return text(compact);
		let result = base;
		if (superscript) {
			const stacked = stackSuperscript(result, superscript);
			if (!stacked) return undefined;
			result = stacked;
		}
		if (subscript) {
			const stacked = stackSubscript(result, subscript);
			if (!stacked) return undefined;
			result = stacked;
		}
		return result;
	}
}

/** Multi-row layout for `$$…$$` and `\[…\]`. Undefined keeps the original source. */
export function renderDisplayMath(source: string): string[] | undefined {
	const trimmed = source.trim();
	if (trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > MAX_MATH_BYTES) return undefined;
	const layout = new MathParser(trimmed, true).parse();
	if (!layout || layout.rows.every((row) => row.trim().length === 0)) return undefined;
	return layout.rows.map((row) => row.trimEnd());
}

/** Single-line rendering for `$…$` and `\(…\)`. Undefined keeps the original source. */
export function renderInlineMath(source: string): string | undefined {
	const trimmed = source.trim();
	if (trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > MAX_MATH_BYTES) return undefined;
	return new MathParser(trimmed, false).parseInline()?.trimEnd();
}

export interface MathReplacement {
	readonly placeholder: string;
	readonly source: string;
	readonly display: boolean;
}

export interface MaskedMathSource {
	readonly text: string;
	readonly replacements: readonly MathReplacement[];
	/** The scan ended inside an unclosed math span, so the next append must re-mask from scratch. */
	readonly pending: boolean;
}

const PLACEHOLDER_PREFIX = "\uE000";
const PLACEHOLDER_SUFFIX = "\uE001";
const MATH_OPERATOR_CHARACTERS = /[\\^_=+\-*/<>]/u;
const INLINE_REJECT_CHARACTERS = /[A-Za-z0-9]/u;

/**
 * Replace complete math spans with inert placeholders before Marked parses the text.
 *
 * TeX escapes such as `\{` and `\\` are otherwise consumed as Markdown escapes. Fenced and
 * inline code keep their literal source, and spans that do not look like math stay untouched
 * so prose such as `cost is $5 and $10` is never rewritten.
 */
export function maskMath(source: string): MaskedMathSource {
	if (!source.includes("$") && !source.includes("\\(") && !source.includes("\\[")) {
		return { text: source, replacements: [], pending: false };
	}
	const replacements: MathReplacement[] = [];
	let text = "";
	let index = 0;
	let fence: string | undefined;
	let lineStart = true;
	while (index < source.length) {
		const rest = source.slice(index);
		if (lineStart) {
			const fenceMatch = /^( {0,3})(`{3,}|~{3,})/u.exec(rest);
			if (fenceMatch) {
				const marker = fenceMatch[2]!;
				fence = fence === undefined ? marker[0] : fence === marker[0] ? undefined : fence;
				lineStart = false;
			}
		}
		if (fence !== undefined) {
			const newline = source.indexOf("\n", index);
			const end = newline < 0 ? source.length : newline + 1;
			text += source.slice(index, end);
			lineStart = newline >= 0;
			index = end;
			continue;
		}
		const character = source[index]!;
		if (character === "`") {
			const run = /^`+/u.exec(rest)![0];
			const close = source.indexOf(run, index + run.length);
			const end = close < 0 ? source.length : close + run.length;
			text += source.slice(index, end);
			lineStart = false;
			index = end;
			continue;
		}
		lineStart = character === "\n";
		const opener = character === "$" && rest.startsWith("$$") ? "$$"
			: rest.startsWith("\\[") ? "\\["
				: rest.startsWith("\\(") ? "\\("
					: character === "$" ? "$" : undefined;
		if (opener === undefined || isEscaped(source, index)) {
			text += character;
			index += 1;
			continue;
		}
		const display = opener === "$$" || opener === "\\[";
		const closer = opener === "$$" ? "$$" : opener === "\\[" ? "\\]" : opener === "\\(" ? "\\)" : "$";
		const start = index + opener.length;
		const closeIndex = findCloser(source, start, closer);
		const body = closeIndex < 0 ? source.slice(start) : source.slice(start, closeIndex);
		if (closeIndex < 0) {
			// An unclosed opener keeps its literal text; the next append re-masks from scratch.
			text += source.slice(index);
			return { text, replacements, pending: display || body.length > 0 };
		}
		const after = source[closeIndex + closer.length];
		if (!display && !acceptsInlineMath(body, after)) {
			text += source.slice(index, closeIndex + closer.length);
			index = closeIndex + closer.length;
			continue;
		}
		if (display && body.trim().length === 0) {
			text += source.slice(index, closeIndex + closer.length);
			index = closeIndex + closer.length;
			continue;
		}
		const placeholder = `${PLACEHOLDER_PREFIX}${replacements.length}${PLACEHOLDER_SUFFIX}`;
		replacements.push({ placeholder, source: body, display });
		text += placeholder;
		index = closeIndex + closer.length;
	}
	return { text, replacements, pending: false };
}

/** Matches the Codex acceptance rules so ordinary prose is never rewritten as math. */
function acceptsInlineMath(body: string, after: string | undefined): boolean {
	if (body.length === 0 || body.trim().length === 0) return false;
	if (body !== body.trim()) return false;
	if (body.includes("\n")) return false;
	if (after !== undefined && INLINE_REJECT_CHARACTERS.test(after)) return false;
	if (body !== "0" && /^[0-9]/u.test(body) && !MATH_OPERATOR_CHARACTERS.test(body)) return false;
	if (body.length > 1 && /^[A-Z]+$/u.test(body)) return false;
	return true;
}

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

function findCloser(source: string, start: number, closer: string): number {
	const limit = Math.min(source.length, start + MAX_MATH_BYTES);
	for (let cursor = start; cursor < limit; cursor += 1) {
		if (source[cursor] !== closer[0]) continue;
		if (!source.startsWith(closer, cursor) || isEscaped(source, cursor)) continue;
		return cursor;
	}
	return -1;
}

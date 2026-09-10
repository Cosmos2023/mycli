import { stableVariantIndex } from "../../stable-variant.ts";

const WORKING_PHRASES = Object.freeze([
	"Working",
	"On it",
	"Making progress",
	"Digging in",
	"Putting it together",
] as const);

const THINKING_PHRASES = Object.freeze([
	"Thinking",
	"Reasoning it through",
	"Working it out",
	"Connecting the dots",
	"Thinking it over",
] as const);

export type TurnActivityLabelOptions = Readonly<{
	text: string;
	kind?: string;
	variantKey: string;
	retryAt?: string;
	nowMs?: number;
}>;

export function turnActivityHeaderText(options: TurnActivityLabelOptions): string {
	const statusText = options.text.trim().replace(/\s+/g, " ");
	const normalizedText = statusText.toLowerCase();
	const normalizedKind = options.kind?.trim().toLowerCase() ?? "";
	if (normalizedKind === "reconnecting" && options.retryAt !== undefined) {
		const remaining = Date.parse(options.retryAt) - (options.nowMs ?? Date.now());
		if (Number.isFinite(remaining)) return `${statusText} in ${Math.max(0, Math.ceil(remaining / 1000))}s`;
	}
	const isGeneric = normalizedText.length === 0
		|| ["running", "streaming", "working"].includes(normalizedText);

	if (normalizedKind === "thinking" && (isGeneric || normalizedText === "thinking")) {
		return stablePhrase(THINKING_PHRASES, `${options.variantKey}:thinking`);
	}
	if (isGeneric) {
		return stablePhrase(WORKING_PHRASES, `${options.variantKey}:working`);
	}
	return statusText;
}

function stablePhrase<const T extends readonly string[]>(phrases: T, variantKey: string): T[number] {
	return phrases[stableVariantIndex(variantKey, phrases.length)]!;
}

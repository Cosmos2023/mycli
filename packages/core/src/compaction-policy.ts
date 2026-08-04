export interface CompactionDecisionInput {
	readonly usedTokens: number;
	readonly tokenLimit: number;
	readonly reservedOutputTokens: number;
	readonly freshSuffixTokens?: number;
	readonly triggerRatio?: number;
}

export type CompactionDecision =
	| { readonly shouldCompact: true; readonly reason: "context_limit" }
	| { readonly shouldCompact: false; readonly reason: null };

const COMPACT: CompactionDecision = Object.freeze({
	shouldCompact: true,
	reason: "context_limit",
});
const KEEP: CompactionDecision = Object.freeze({
	shouldCompact: false,
	reason: null,
});

export function decideCompaction(input: CompactionDecisionInput): CompactionDecision {
	const usedTokens = tokenCount(input.usedTokens, "usedTokens");
	const tokenLimit = tokenCount(input.tokenLimit, "tokenLimit");
	const reservedOutputTokens = tokenCount(
		input.reservedOutputTokens,
		"reservedOutputTokens",
	);
	const freshSuffixTokens = tokenCount(input.freshSuffixTokens ?? 0, "freshSuffixTokens");
	if (freshSuffixTokens > usedTokens) {
		throw new RangeError("freshSuffixTokens cannot exceed usedTokens");
	}
	const ratio = input.triggerRatio ?? 1;
	if (!Number.isFinite(ratio)) {
		throw new RangeError("triggerRatio must be finite");
	}
	const triggerRatio = Math.max(0, Math.min(1, ratio));
	const usableInputBudget = Math.max(0, tokenLimit - reservedOutputTokens);
	const triggerTokens = usableInputBudget * triggerRatio;
	if (usedTokens === 0 || usedTokens <= freshSuffixTokens) {
		return KEEP;
	}
	return usedTokens >= triggerTokens ? COMPACT : KEEP;
}

function tokenCount(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer`);
	}
	return value;
}

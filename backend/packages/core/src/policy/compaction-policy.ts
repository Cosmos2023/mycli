export type CompactionLimitScope = "total" | "body_after_prefix";

export interface CompactionDecisionInput {
	readonly usedTokens: number;
	readonly tokenLimit: number;
	readonly reservedOutputTokens: number;
	readonly scope?: CompactionLimitScope;
	readonly baseContextTokens?: number;
	readonly hardLimitTokens?: number;
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
	const baseContextTokens = tokenCount(input.baseContextTokens ?? 0, "baseContextTokens");
	if (baseContextTokens > usedTokens) {
		throw new RangeError("baseContextTokens cannot exceed usedTokens");
	}
	const hardLimitTokens = input.hardLimitTokens === undefined
		? undefined
		: tokenCount(input.hardLimitTokens, "hardLimitTokens");
	const scope = compactionLimitScope(input.scope);
	const ratio = input.triggerRatio ?? 1;
	if (!Number.isFinite(ratio)) {
		throw new RangeError("triggerRatio must be finite");
	}
	const triggerRatio = Math.max(0, Math.min(1, ratio));
	// A carried prefix cannot be summarized away, so the configured scope decides
	// whether it competes with conversation tokens for the same trigger budget.
	const scopeTokens = scope === "body_after_prefix"
		? usedTokens - baseContextTokens
		: usedTokens;
	const usableInputBudget = Math.max(0, tokenLimit - reservedOutputTokens);
	const triggerTokens = usableInputBudget * triggerRatio;
	if (usedTokens === 0 || scopeTokens <= freshSuffixTokens) {
		return KEEP;
	}
	if (scopeTokens >= triggerTokens) return COMPACT;
	// The model window stays a hard cap no matter how the trigger scope is set.
	return hardLimitTokens !== undefined && usedTokens >= hardLimitTokens ? COMPACT : KEEP;
}

function compactionLimitScope(value: CompactionLimitScope | undefined): CompactionLimitScope {
	if (value === undefined || value === "total") return "total";
	if (value === "body_after_prefix") return value;
	throw new RangeError("scope must be 'total' or 'body_after_prefix'");
}

function tokenCount(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer`);
	}
	return value;
}

export type PlanImplementationAction = "implement" | "clear_context";

export type PlanImplementationChoice = PlanImplementationAction | "stay";

export const PLAN_IMPLEMENTATION_CODING_MESSAGE = "Implement the plan.";

export const PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX = [
	"A previous agent produced the plan below to accomplish the user's task.",
	"Implement the plan in a fresh context. Treat the plan as the source of user intent,",
	"re-read files as needed, and carry the work through implementation and verification.",
].join(" ");

export function planImplementationContextUsageLabel(
	contextPercent: number | undefined,
	contextUsedTokens: number | undefined,
): string | undefined {
	if (contextPercent !== undefined && Number.isFinite(contextPercent)) {
		const clamped = Math.min(100, Math.max(0, contextPercent));
		const usedPercent = 100 - Math.round(100 - clamped);
		return usedPercent > 0 ? `${usedPercent}% used` : undefined;
	}
	if (contextUsedTokens === undefined || !Number.isFinite(contextUsedTokens)) return undefined;
	const usedTokens = Math.max(0, Math.round(contextUsedTokens));
	return usedTokens > 0 ? `${formatTokensCompact(usedTokens)} used` : undefined;
}

export function planImplementationMessage(
	action: PlanImplementationAction,
	planMarkdown: string,
): string {
	if (action === "implement") return PLAN_IMPLEMENTATION_CODING_MESSAGE;
	return `${PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n${planMarkdown.trim()}`;
}

function formatTokensCompact(value: number): string {
	if (value < 1_000) return String(value);
	const [divisor, suffix] = value >= 1_000_000_000_000
		? [1_000_000_000_000, "T"] as const
		: value >= 1_000_000_000
			? [1_000_000_000, "B"] as const
			: value >= 1_000_000
				? [1_000_000, "M"] as const
				: [1_000, "K"] as const;
	const scaled = value / divisor;
	const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
	const formatted = scaled.toFixed(decimals);
	const compact = formatted.includes(".")
		? formatted.replace(/0+$/u, "").replace(/\.$/u, "")
		: formatted;
	return `${compact}${suffix}`;
}

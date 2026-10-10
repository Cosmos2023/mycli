import type { SessionGoal } from "./generated/session-goal.ts";

/** Stop reason the runtime writes when a restored session pauses its goal. */
export const GOAL_RESTORED_STOP_REASON = "Session restored. Resume the goal to continue.";

/** Codex scales goal tokens to a compact suffix so a status line stays short. */
export function formatGoalTokensCompact(value: number): string {
	const tokens = Math.max(0, Math.floor(value));
	if (tokens === 0) return "0";
	if (tokens < 1_000) return String(tokens);
	const [scale, suffix] = tokens >= 1_000_000_000_000 ? [1_000_000_000_000, "T"]
		: tokens >= 1_000_000_000 ? [1_000_000_000, "B"]
			: tokens >= 1_000_000 ? [1_000_000, "M"] : [1_000, "K"];
	const scaled = tokens / scale;
	const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
	const formatted = scaled.toFixed(decimals);
	return `${formatted.includes(".") ? formatted.replace(/0+$/u, "").replace(/\.$/u, "") : formatted}${suffix}`;
}

/** Codex goal time: seconds, minutes, hours with minutes, then days. */
export function formatGoalElapsed(elapsedMs: number): string {
	const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h ${remainingMinutes}m`;
	return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

/** Status-line usage: budgeted goals show tokens, unbudgeted ones show elapsed time. */
export function goalStatusUsage(goal: SessionGoal): string | undefined {
	const used = `${formatGoalTokensCompact(goal.tokens_used)}${goal.usage_incomplete ? "+" : ""}`;
	if (goal.status === "active") {
		return goal.token_budget === null ? formatGoalElapsed(goal.elapsed_ms)
			: `${used} / ${formatGoalTokensCompact(goal.token_budget)}`;
	}
	if (goal.status === "budget_limited") {
		return goal.token_budget === null ? undefined : `${used} / ${formatGoalTokensCompact(goal.token_budget)} tokens`;
	}
	if (goal.status === "complete") {
		return goal.token_budget === null ? formatGoalElapsed(goal.elapsed_ms) : `${used} tokens`;
	}
	return undefined;
}

/** `/goal` summary body, following Codex's goal summary and per-status command hints. */
export function goalSummaryLines(goal: SessionGoal): string[] {
	const lines = [
		`Status: ${goal.status.replaceAll("_", " ")}`,
		`Objective: ${goal.objective}`,
		`Time used: ${formatGoalElapsed(goal.elapsed_ms)}`,
		`Tokens used: ${formatGoalTokensCompact(goal.tokens_used)}${goal.usage_incomplete ? "+" : ""}`,
	];
	if (goal.token_budget !== null) lines.push(`Token budget: ${formatGoalTokensCompact(goal.token_budget)}`);
	if (goal.rounds_started > 0) lines.push(`Continuations: ${goal.rounds_started}`);
	if (goal.stop_reason) lines.push(goal.stop_reason);
	lines.push("");
	lines.push(`Commands: ${goalCommandHint(goal.status)}`);
	return lines;
}

function goalCommandHint(status: SessionGoal["status"]): string {
	if (status === "active") return "/goal edit, /goal pause, /goal budget, /goal clear";
	if (status === "paused" || status === "blocked" || status === "usage_limited") {
		return "/goal edit, /goal resume, /goal budget, /goal clear";
	}
	return "/goal edit, /goal budget, /goal clear";
}

import { GoalStateError } from "@mycli/core";
import type { SessionGoalService } from "@mycli/runtime";
import type { GatewayParams, SessionGoal } from "@mycli/contracts";
import { GatewayFailure } from "./node-gateway-errors.ts";

export type GoalControl = GatewayParams<"goal.update">;

export function parseGoalCommand(args: string): GoalControl | null {
	const text = args.trim();
	if (!text) return null;
	if (text === "pause" || text === "resume" || text === "clear") return { action: text };
	if (text === "edit" || text === "budget") throw new GatewayFailure("invalid_arguments", "Use /goal edit <objective> or /goal budget <tokens|off>.");
	if (text.startsWith("edit ")) return { action: "edit", objective: text.slice(5).trim() };
	if (text.startsWith("budget ")) {
		const value = text.slice(7).trim();
		if (value !== "off" && !/^[1-9]\d*$/.test(value)) throw new GatewayFailure("invalid_arguments", "Use /goal budget <positive integer|off>.");
		return { action: "edit", token_budget: value === "off" ? null : Number(value) };
	}
	const budgeted = /^--tokens\s+([1-9]\d*)\s+([\s\S]+)$/.exec(text);
	if (text.startsWith("--") && !budgeted) throw new GatewayFailure("invalid_arguments", "Use /goal [--tokens <positive integer>] <objective>.");
	return { action: "create", objective: budgeted?.[2] ?? text, ...(budgeted ? { token_budget: Number(budgeted[1]) } : {}) };
}

export function applyGoalControl(service: SessionGoalService, input: GoalControl): SessionGoal | null {
	try {
		const current = service.get();
		if ((input.expected_goal_id !== undefined && input.expected_goal_id !== current?.goal_id)
			|| (input.expected_revision !== undefined && input.expected_revision !== current?.revision)) {
			throw new GoalStateError("goal_changed", "The goal changed. Reopen /goal before applying this action.");
		}
		switch (input.action) {
			case "create":
				if (typeof input.objective !== "string") throw new GoalStateError("goal_invalid_objective", "A goal objective is required.");
				return service.create({ objective: input.objective, tokenBudget: input.token_budget });
			case "edit": return service.edit({ objective: input.objective, tokenBudget: input.token_budget });
			case "pause": return service.setStatus("paused", "Goal paused by the user.");
			case "resume": return service.setStatus("active");
			case "clear": service.clear(); return null;
		}
	} catch (error) {
		if (error instanceof GoalStateError) throw new GatewayFailure("invalid_arguments", error.message);
		throw error;
	}
}

export function describeGoal(goal: SessionGoal | null): string {
	if (!goal) return "No goal. Create one with /goal <objective>, optionally /goal --tokens 50000 <objective>.";
	return [
		goal.objective,
		`Status: ${goal.status.replaceAll("_", " ")} · Continuations: ${goal.rounds_started}`,
		`Tokens: ${goal.tokens_used}${goal.usage_incomplete ? "+ (usage incomplete)" : ""}${goal.token_budget === null ? " (no budget)" : ` / ${goal.token_budget}`} · Active time: ${Math.floor(goal.elapsed_ms / 1000)}s`,
		...(goal.stop_reason ? [goal.stop_reason] : []),
		"/goal pause · /goal resume · /goal edit <objective> · /goal budget <tokens|off> · /goal clear",
	].join("\n");
}

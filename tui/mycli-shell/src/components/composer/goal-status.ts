import type { SessionGoal } from "@mycli/contracts";
import { truncateToWidth, visibleWidth } from "../../tui-core/utils.ts";
import { theme } from "../../theme/theme.ts";
import { joinStatusParts } from "./status-line.ts";

export function goalStatusLabel(goal: SessionGoal): string {
	return `Goal ${goal.status.replaceAll("_", " ")}`;
}

export function renderGoalStatus(goal: SessionGoal, width: number): string {
	if (width <= 0) return "";
	const status = goalStatusLabel(goal);
	const usage = `${goal.tokens_used}${goal.usage_incomplete ? "+" : ""}${goal.token_budget === null ? "" : `/${goal.token_budget}`} tokens`;
	const action = goal.status === "active" ? "/goal pause"
		: ["paused", "blocked", "usage_limited"].includes(goal.status) ? "/goal resume" : "/goal";
	const candidates = [joinStatusParts([status, usage, action]), joinStatusParts([status, action]), status];
	const text = candidates.find((candidate) => visibleWidth(candidate) <= width) ?? status;
	const color = goal.status === "active" ? "accent" : goal.status === "complete" ? "success" : "warning";
	return theme.fg(color, truncateToWidth(text, width, "..."));
}

import { goalStatusHeadline, goalStatusLabel, type SessionGoal } from "@mycli/contracts";
import { truncateToWidth, visibleWidth } from "../../tui-core/utils.ts";
import { theme } from "../../theme/theme.ts";
import { joinStatusParts } from "./status-line.ts";

/** Wall-clock inputs the goal row needs to keep its own timer moving. */
export interface GoalStatusTiming {
	readonly now: number;
	/** When the current goal snapshot arrived, or null when it has not been seen yet. */
	readonly observedAtMs: number | null;
	/** Start of the running turn, or null when no turn is running. */
	readonly turnStartedAtMs: number | null;
}

/**
 * Codex advances the goal clock locally: a snapshot's `elapsed_ms` is authoritative at the moment it
 * arrives, and only time spent inside a running turn is added on top of it.
 */
export function goalWithLiveElapsed(goal: SessionGoal, timing: GoalStatusTiming): SessionGoal {
	if (goal.status !== "active" || timing.turnStartedAtMs === null) return goal;
	const baseline = Math.max(timing.observedAtMs ?? timing.turnStartedAtMs, timing.turnStartedAtMs);
	const activeMs = Math.max(0, timing.now - baseline);
	return activeMs === 0 ? goal : { ...goal, elapsed_ms: goal.elapsed_ms + activeMs };
}

export function renderGoalStatus(goal: SessionGoal, width: number, timing?: GoalStatusTiming): string {
	if (width <= 0) return "";
	const live = timing ? goalWithLiveElapsed(goal, timing) : goal;
	const label = goalStatusLabel(live);
	// The objective is the one thing Codex leaves to `/goal`; show it when the row has room.
	const objective = live.objective.trim().replace(/\s+/gu, " ");
	const candidates = [
		...(objective ? [joinStatusParts([label, objective])] : []),
		label,
		goalStatusHeadline(live),
	];
	const text = candidates.find((candidate) => visibleWidth(candidate) <= width)
		?? candidates[candidates.length - 1]!;
	const color = goal.status === "active" ? "accent" : goal.status === "complete" ? "success" : "warning";
	return theme.fg(color, truncateToWidth(text, width, "..."));
}

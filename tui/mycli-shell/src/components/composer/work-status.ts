import type { MycliShellFooterData } from "../../model.ts";
import { theme } from "../../theme/theme.ts";
import type { Component } from "../../tui-core/tui.ts";
import { visibleWidth } from "../../tui-core/utils.ts";
import { renderGoalStatus, type GoalStatusTiming } from "./goal-status.ts";
import { alignStatusColumns, insetStatusLine, joinStatusParts, sanitizeStatusText, statusLineWidth } from "./status-line.ts";

/** Bounded work summaries, separate from transcript history and session context. */
export class WorkStatusComponent implements Component {
	constructor(
		private readonly data: MycliShellFooterData,
		private readonly options: {
			readonly leadingSpace?: boolean;
			readonly now?: () => number;
			/** When the current goal snapshot arrived, so the goal clock can keep moving. */
			readonly goalObservedAtMs?: number | null;
			readonly turnStartedAtMs?: number | null;
		} = {},
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const contentWidth = statusLineWidth(width);
		const rows: string[] = [];
		// The goal owns its own row: sharing one line with the background-terminal counter squeezed
		// both of them and hid the objective.
		const goal = this.goalRow(contentWidth);
		if (goal) rows.push(goal);
		const shells = this.shellRow(contentWidth);
		if (shells) rows.push(shells);
		const extensions = [...new Set((this.data.extensionStatuses ?? []).map(sanitizeStatusText).filter(Boolean))];
		if (extensions.length > 0) rows.push(this.extensionRow(extensions, contentWidth));
		if (rows.length === 0) return [];
		const lines = rows.map((row) => insetStatusLine(row, width));
		return this.options.leadingSpace === false ? lines : ["", ...lines];
	}

	private extensionRow(extensions: readonly string[], width: number): string {
		let kept = extensions.length;
		let text = joinStatusParts(extensions);
		while (visibleWidth(text) > width && kept > 1) {
			kept -= 1;
			text = joinStatusParts([...extensions.slice(0, kept), `+${extensions.length - kept} more`]);
		}
		if (visibleWidth(text) > width && extensions.length > 1) {
			text = alignStatusColumns(extensions[0]!, `+${extensions.length - 1} more`, width);
		}
		return theme.fg("dim", text);
	}

	private goalRow(width: number): string {
		const goal = this.data.goal;
		if (!goal) return "";
		return renderGoalStatus(goal, width, this.goalTiming());
	}

	private goalTiming(): GoalStatusTiming | undefined {
		const now = this.options.now;
		if (!now) return undefined;
		return {
			now: now(),
			observedAtMs: this.options.goalObservedAtMs ?? null,
			turnStartedAtMs: this.options.turnStartedAtMs ?? null,
		};
	}

	private shellRow(width: number): string {
		const count = this.data.backgroundShellCount ?? 0;
		if (count === 0) return "";
		const label = joinStatusParts([`${count} ${count === 1 ? "shell" : "shells"}`, "/ps"]);
		return alignStatusColumns("", theme.fg("muted", label), width);
	}
}

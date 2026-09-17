import type { MycliShellFooterData } from "../../model.ts";
import { theme } from "../../theme/theme.ts";
import type { Component } from "../../tui-core/tui.ts";
import { visibleWidth } from "../../tui-core/utils.ts";
import { goalStatusLabel, renderGoalStatus } from "./goal-status.ts";
import { alignStatusColumns, insetStatusLine, joinStatusParts, sanitizeStatusText, statusLineWidth } from "./status-line.ts";

/** Bounded work summaries, separate from transcript history and session context. */
export class WorkStatusComponent implements Component {
	constructor(
		private readonly data: MycliShellFooterData,
		private readonly options: { readonly leadingSpace?: boolean } = {},
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const contentWidth = statusLineWidth(width);
		const rows: string[] = [];
		const work = this.workRow(contentWidth);
		if (visibleWidth(work) > 0) rows.push(work);
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

	private workRow(width: number): string {
		const goal = this.data.goal;
		const count = this.data.backgroundShellCount ?? 0;
		let shells = count > 0 ? joinStatusParts([`${count} ${count === 1 ? "shell" : "shells"}`, "/ps"]) : "";
		const primaryLabel = goal ? goalStatusLabel(goal) : "";
		if (shells && visibleWidth(primaryLabel) + 2 + visibleWidth(shells) > width) shells = `${count} ${count === 1 ? "shell" : "shells"}`;
		if (goal && shells && visibleWidth(primaryLabel) + 2 + visibleWidth(shells) > width) shells = "";
		const leftWidth = shells ? Math.max(0, width - visibleWidth(shells) - 2) : width;
		const left = goal ? renderGoalStatus(goal, leftWidth) : "";
		return alignStatusColumns(left, theme.fg("muted", shells), width);
	}
}

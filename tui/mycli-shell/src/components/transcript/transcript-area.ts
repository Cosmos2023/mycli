import type { Component } from "../../tui-core/tui.ts";
import { visibleWidth } from "../../tui-core/utils.ts";

export interface TranscriptFollowControl {
	readonly row: number;
	readonly startColumn: number;
	readonly endColumn: number;
}

/** Keep live status next to output while reserving the remaining space above input. */
export class TranscriptAreaComponent implements Component {
	/** Rendered rectangle of the return-to-bottom affordance, if visible. */
	followControl?: TranscriptFollowControl;

	constructor(
		private readonly viewport: Component,
		private readonly status: Component,
		private readonly heightForWidth: (width: number) => number,
		private readonly followLabel?: () => string | undefined,
	) {}

	invalidate(): void {
		this.viewport.invalidate();
		this.status.invalidate();
	}

	render(width: number): string[] {
		const viewportLines = this.viewport.render(width);
		const lines = [...viewportLines, ...this.status.render(width)];
		const height = this.heightForWidth(width);
		while (lines.length < height) lines.push("");
		this.followControl = undefined;
		const label = this.followLabel?.();
		if (label && viewportLines.length > 0) {
			const row = viewportLines.length - 1;
			const startColumn = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
			lines[row] = `${" ".repeat(startColumn)}${label}`;
			this.followControl = { row, startColumn, endColumn: startColumn + visibleWidth(label) };
		}
		return lines;
	}
}

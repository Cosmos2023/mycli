import type { Component } from "../../tui-core/tui.ts";

/** Keep live status next to output while reserving the remaining space above input. */
export class TranscriptAreaComponent implements Component {
	constructor(
		private readonly viewport: Component,
		private readonly status: Component,
		private readonly heightForWidth: (width: number) => number,
	) {}

	invalidate(): void {
		this.viewport.invalidate();
		this.status.invalidate();
	}

	render(width: number): string[] {
		const lines = [...this.viewport.render(width), ...this.status.render(width)];
		const height = this.heightForWidth(width);
		while (lines.length < height) lines.push("");
		return lines;
	}
}

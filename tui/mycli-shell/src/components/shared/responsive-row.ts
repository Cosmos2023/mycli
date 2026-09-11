import type { Component } from "../../tui-core/tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../tui-core/utils.ts";

export class ResponsiveDescriptionRow implements Component {
	constructor(
		private readonly prefix: string,
		private readonly label: string,
		private readonly description = "",
		private readonly paddingX = 1,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const combined = this.description ? `${this.prefix}${this.label}  ${this.description}` : `${this.prefix}${this.label}`;
		if (visibleWidth(combined) <= contentWidth) {
			return [this.withPadding(combined, width)];
		}

		const prefixWidth = visibleWidth(this.prefix);
		const labelWidth = Math.max(1, contentWidth - prefixWidth);
		const labelLines = wrapTextWithAnsi(this.label, labelWidth);
		const lines = labelLines.map((line, index) => `${index === 0 ? this.prefix : " ".repeat(prefixWidth)}${line}`);
		if (this.description) {
			const descriptionIndent = Math.min(Math.max(prefixWidth + 2, 2), Math.max(0, contentWidth - 1));
			const descriptionWidth = Math.max(1, contentWidth - descriptionIndent);
			for (const line of wrapTextWithAnsi(this.description, descriptionWidth)) {
				lines.push(`${" ".repeat(descriptionIndent)}${line}`);
			}
		}
		return lines.map((line) => this.withPadding(line, width));
	}

	private withPadding(line: string, width: number): string {
		const available = Math.max(1, width - this.paddingX * 2);
		return `${" ".repeat(this.paddingX)}${truncateToWidth(line, available, "", true)}`;
	}
}

export class SegmentedHintLine implements Component {
	constructor(
		private readonly segments: readonly string[],
		private readonly paddingX = 1,
		private readonly separator = "  ",
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const lines: string[] = [];
		let current = "";
		for (const segment of this.segments.filter((value) => value.trim())) {
			const fitted = truncateToWidth(segment, contentWidth, "...");
			const candidate = current ? `${current}${this.separator}${fitted}` : fitted;
			if (current && visibleWidth(candidate) > contentWidth) {
				lines.push(current);
				current = fitted;
			} else {
				current = candidate;
			}
		}
		if (current) lines.push(current);
		return lines.map((line) => `${" ".repeat(this.paddingX)}${line}`);
	}
}

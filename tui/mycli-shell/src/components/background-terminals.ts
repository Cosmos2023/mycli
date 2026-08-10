import type { Component } from "../tui-core/tui.ts";
import { truncateToWidth } from "../tui-core/utils.ts";
import type { MycliShellBackgroundTerminals } from "../model.ts";
import { theme } from "../theme/theme.ts";

const PROCESS_LIMIT = 16;

export class BackgroundTerminalsComponent implements Component {
	constructor(private readonly backgroundTerminals: MycliShellBackgroundTerminals) {}

	invalidate(): void {}

	getRenderCacheKey(): number {
		return 0;
	}

	render(width: number): string[] {
		const lines = ["", this.line(theme.fg("dim", "/ps"), width), "", this.line(theme.bold("Background terminals"), width), ""];
		const visibleProcesses = this.backgroundTerminals.processes.slice(0, PROCESS_LIMIT);
		if (visibleProcesses.length === 0) {
			lines.push(this.line(theme.fg("muted", "  No background terminals running."), width));
			return lines;
		}

		for (const process of visibleProcesses) {
			lines.push(this.line(`${theme.fg("accent", "  •")} ${sanitizeLine(process.commandPreview) || "command"}`, width));
			for (const output of process.recentOutput) {
				lines.push(this.line(theme.fg("muted", `    ↳ ${sanitizeLine(output)}`), width));
			}
		}
		const hiddenCount = this.backgroundTerminals.processes.length - visibleProcesses.length;
		if (hiddenCount > 0) {
			lines.push(this.line(theme.fg("muted", `  ... and ${hiddenCount} more running`), width));
		}
		return lines;
	}

	private line(text: string, width: number): string {
		return truncateToWidth(text, Math.max(0, width), theme.fg("dim", "..."));
	}
}

function sanitizeLine(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

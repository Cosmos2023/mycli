import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellBash } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { sanitizeInline, shortPreview } from "./tool-display.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const PREVIEW_LINES = 12;

export class BashExecutionComponent extends Container {
	private bash: MycliShellBash;

	constructor(bash: MycliShellBash) {
		super();
		this.bash = bash;
		this.rebuild();
	}

	updateBash(bash: MycliShellBash): void {
		this.bash = bash;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${theme.fg("bashMode", theme.bold("⏺"))} ${theme.fg("bashMode", theme.bold("Bash"))}`, 1, 0));
		this.addChild(new Text(this.resultLine(), 3, 0));
		if (this.bash.outputPreview) {
			this.addChild(this.outputComponent());
		}
	}

	private outputComponent(): Text | { render: (width: number) => string[]; invalidate: () => void } {
		if (!this.bash.outputPreview) {
			return new Text("", 1, 0);
		}
		if (this.bash.expanded) {
			return new Text(theme.fg("muted", this.bash.outputPreview), 5, 0);
		}
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
			render: (width: number) => {
				if (cachedWidth !== width || !cachedLines) {
					const result = truncateToVisualLines(theme.fg("muted", this.bash.outputPreview ?? ""), PREVIEW_LINES, width, 5);
					cachedLines = result.visualLines;
					const hiddenCount = Math.max(this.bash.hiddenLineCount ?? 0, result.skippedCount);
					if (hiddenCount > 0) {
						cachedLines = [
							...cachedLines,
							...new Text(theme.fg("muted", this.hiddenLinesText(hiddenCount)), 5, 0).render(width),
						];
					}
					cachedWidth = width;
				}
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
	}

	private resultLine(): string {
		const command = commandPreview(this.bash.command) ?? "command";
		if (this.bash.status === "running") {
			return theme.fg("muted", `⎿ ${command} · Running... (${keyHint("app.interrupt", "to cancel")})`);
		}
		const status =
			this.bash.status === "error" && this.bash.exitCode !== undefined
				? `exit ${this.bash.exitCode}`
				: this.bash.status;
		return theme.fg(this.bash.status === "error" ? "error" : "muted", `⎿ ${command} · ${status}`);
	}

	private hiddenLinesText(hiddenCount: number): string {
		return this.bash.expanded
			? keyHint("app.tools.expand", "collapse")
			: `... ${hiddenCount} more lines (${keyHint("app.tools.expand", "expand")})`;
	}
}

function commandPreview(command: string): string | undefined {
	const lines = command.split(/\r?\n/).map((line) => sanitizeInline(line)).filter(Boolean);
	if (lines.length <= 1) {
		return shortPreview(command);
	}
	const firstLine = shortPreview(lines[0], 64);
	return firstLine ? `${firstLine}…` : undefined;
}

import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellBash } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { presentationForBash } from "./tool-presentation.ts";
import { sanitizeInline, shortPreview } from "./tool-display.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

export class BashExecutionComponent extends Container {
	private bash: MycliShellBash;
	private readonly now: () => number;

	constructor(bash: MycliShellBash, now: () => number = Date.now) {
		super();
		this.bash = bash;
		this.now = now;
		this.rebuild();
	}

	updateBash(bash: MycliShellBash): void {
		this.bash = bash;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(this.statusComponent());
		const terminalDetail = this.terminalDetail();
		if (terminalDetail) {
			this.addChild(new Text(theme.fg("muted", `└ ${terminalDetail}`), 1, 0));
		}
		if (this.bash.outputPreview) {
			this.addChild(this.outputComponent());
		}
	}

	private statusComponent(): { render: (width: number) => string[]; invalidate: () => void } {
		return {
			render: (width: number) => new Text(this.statusLine(), 1, 0).render(width),
			invalidate: () => {},
		};
	}

	private outputComponent(): Text | { render: (width: number) => string[]; invalidate: () => void } {
		if (!this.bash.outputPreview) {
			return new Text("", 1, 0);
		}
		if (this.bash.expanded) {
			return new Text(theme.fg("muted", this.connectedOutput()), 1, 0);
		}
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
				render: (width: number) => {
				if (cachedWidth !== width || !cachedLines) {
					const result = truncateToVisualLines(
						theme.fg("muted", this.connectedOutput()),
						presentationForBash().terminalPreviewLines,
						width,
						1,
					);
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

	private statusLine(): string {
		const command = commandPreview(this.bash.command) ?? "command";
		if (this.bash.status === "running") {
			const details: string[] = [];
			const elapsed = this.elapsedSeconds();
			if (elapsed !== undefined) {
				details.push(`${elapsed}s`);
			}
			if (this.bash.background !== true) {
				details.push("esc to interrupt");
			}
			const suffix = details.length > 0 ? ` (${details.join(" · ")})` : "";
			return `${theme.fg("accent", theme.bold("•"))} ${theme.bold("Running")} ${command}${suffix}`;
		}
		const color = this.bash.status === "success" ? "success" : "error";
		return `${theme.fg(color, theme.bold("•"))} ${theme.bold("Ran")} ${command}`;
	}

	private elapsedSeconds(): number | undefined {
		if (!this.bash.startedAt) return undefined;
		const started = Date.parse(this.bash.startedAt);
		if (!Number.isFinite(started)) return undefined;
		return Math.max(0, Math.floor((this.now() - started) / 1000));
	}

	private terminalDetail(): string | undefined {
		const details: string[] = [];
		if (this.bash.expanded) {
			details.push(`Shell: ${shellDisplayName(this.bash)}`);
		}
		if (this.bash.status === "running") return details.join(" · ") || undefined;
		if (this.bash.exitCode !== undefined && this.bash.exitCode !== 0) {
			details.push(`exit ${this.bash.exitCode}`);
		}
		if (this.bash.terminalState === "timed_out") details.push("timed out");
		if (this.bash.terminalState === "interrupted") details.push("interrupted");
		if (this.bash.terminalState === "killed") details.push("killed");
		return details.join(" · ") || undefined;
	}

	private connectedOutput(): string {
		return (this.bash.outputPreview ?? "")
			.split(/\r?\n/)
			.map((line, index) => `${index === 0 ? "└" : " "} ${line}`)
			.join("\n");
	}

	private hiddenLinesText(hiddenCount: number): string {
		return this.bash.expanded
			? keyHint("app.tools.expand", "collapse")
			: `... ${hiddenCount} more lines (${keyHint("app.tools.expand", "expand")})`;
	}
}

function shellDisplayName(shell: MycliShellBash): string {
	if (shell.shellKind === "powershell") {
		return shell.shellEdition === "desktop" ? "Windows PowerShell 5.1" : "PowerShell 7";
	}
	if (shell.shellKind === "cmd") return "cmd";
	if (shell.shellKind) return shell.shellKind;
	return shell.toolName === "Bash" ? "Bash" : "Shell";
}

function commandPreview(command: string): string | undefined {
	const lines = command.split(/\r?\n/).map((line) => sanitizeInline(line)).filter(Boolean);
	if (lines.length <= 1) {
		return shortPreview(command);
	}
	const firstLine = shortPreview(lines[0], 64);
	return firstLine ? `${firstLine}…` : undefined;
}

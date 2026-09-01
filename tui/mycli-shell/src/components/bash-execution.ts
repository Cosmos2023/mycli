import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "../tui-core/utils.ts";
import type { MycliShellBash } from "../model.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { presentationForBash } from "./tool-presentation.ts";
import { TRANSCRIPT_HEADER_INDENT } from "./transcript-gutter.ts";
import { truncateToVisualLines, truncateVisualLinesBalanced } from "./visual-truncate.ts";

const COMMAND_CONTINUATION_MAX_LINES = 2;
const COMMAND_OUTPUT_SUBSEQUENT_PREFIX = "    ";
const SHELL_CELL_PADDING_X = TRANSCRIPT_HEADER_INDENT;

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

	override getRenderCacheKey(): number | undefined {
		return this.bash.status === "running" ? undefined : super.getRenderCacheKey();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(this.statusComponent());
		if (this.bash.expanded) {
			this.addChild(new Text(theme.fg("muted", this.commandDetail()), SHELL_CELL_PADDING_X, 0));
		}
		const terminalDetail = this.terminalDetail();
		if (terminalDetail) {
			this.addChild(new Text(theme.fg("muted", `${commandOutputInitialPrefix()}${terminalDetail}`), SHELL_CELL_PADDING_X, 0));
		}
		if (this.bash.outputPreview) {
			this.addChild(this.outputComponent());
		}
	}

	private statusComponent(): { render: (width: number) => string[]; invalidate: () => void } {
		return {
			render: (width: number) => {
				const contentWidth = Math.max(1, width - SHELL_CELL_PADDING_X * 2);
				return new Text(this.statusLines(contentWidth).join("\n"), SHELL_CELL_PADDING_X, 0).render(width);
			},
			invalidate: () => {},
		};
	}

	private outputComponent(): Text | { render: (width: number) => string[]; invalidate: () => void } {
		if (!this.bash.outputPreview) {
			return new Text("", SHELL_CELL_PADDING_X, 0);
		}
		if (this.bash.expanded) {
			return {
				render: (width: number) => new Text(
					theme.fg("muted", this.connectedOutput(width)),
					SHELL_CELL_PADDING_X,
					0,
				).render(width),
				invalidate: () => {},
			};
		}
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
			render: (width: number) => {
				if (cachedWidth !== width || !cachedLines) {
					const maxLines = presentationForBash().terminalPreviewLines;
					const output = theme.fg("muted", this.connectedOutput(width));
					const result = this.bash.status === "running"
						? truncateToVisualLines(output, maxLines, width, SHELL_CELL_PADDING_X)
						: truncateVisualLinesBalanced(output, maxLines, width, SHELL_CELL_PADDING_X, (skippedCount) =>
								theme.fg("muted", this.indentedHiddenLinesText(Math.max(this.bash.hiddenLineCount ?? 0, skippedCount))),
						);
					cachedLines = result.visualLines;
					const outputPrefix = `${" ".repeat(SHELL_CELL_PADDING_X)}${commandOutputInitialPrefix()}`;
					const outputPrefixWidth = visibleWidth(outputPrefix);
					if (this.bash.status === "running" && result.skippedCount > 0 && cachedLines.length > 0 && width > outputPrefixWidth) {
						cachedLines = [
							`${theme.fg("muted", outputPrefix)}${sliceByColumn(cachedLines[0] ?? "", outputPrefixWidth, width - outputPrefixWidth)}`,
							...cachedLines.slice(1),
						];
					}
					const hiddenCount = this.bash.hiddenLineCount ?? 0;
					if (this.bash.status !== "running" && result.skippedCount === 0 && hiddenCount > 0) {
						const marker = new Text(
							theme.fg("muted", this.indentedHiddenLinesText(hiddenCount)),
							SHELL_CELL_PADDING_X,
							0,
						).render(width);
						const retainedLines = cachedLines.slice(0, Math.max(0, maxLines - marker.length));
						const headLineCount = Math.ceil(retainedLines.length / 2);
						cachedLines = [
							...retainedLines.slice(0, headLineCount),
							...marker.slice(0, maxLines - retainedLines.length),
							...retainedLines.slice(headLineCount),
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

	private statusLines(width: number): string[] {
		if (this.bash.status === "running") {
			const details: string[] = [];
			const elapsed = this.elapsedSeconds();
			if (elapsed !== undefined) {
				details.push(`${elapsed}s`);
			}
			if (this.bash.background !== true && this.bash.yielded !== true) {
				details.push("esc to interrupt");
			}
			const suffix = details.length > 0 ? ` (${details.join(` ${uiGlyphs().separator} `)})` : "";
			const prefix = `${theme.fg("accent", theme.bold(uiGlyphs().bullet))} ${theme.bold("Running")} `;
			return commandDisplayLines(this.bash.command, prefix, suffix, width);
		}
		const color = this.bash.status === "success" ? "success" : "error";
		const prefix = `${theme.fg(color, theme.bold(uiGlyphs().bullet))} ${theme.bold("Ran")} `;
		return commandDisplayLines(this.bash.command, prefix, "", width);
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
		if (this.bash.status === "running") return details.join(` ${uiGlyphs().separator} `) || undefined;
		if (this.bash.exitCode !== undefined && this.bash.exitCode !== 0) {
			details.push(`exit ${this.bash.exitCode}`);
		}
		if (this.bash.terminalState === "timed_out") details.push("timed out");
		if (this.bash.terminalState === "interrupted") details.push("interrupted");
		if (this.bash.terminalState === "killed") details.push("killed");
		return details.join(` ${uiGlyphs().separator} `) || undefined;
	}

	private connectedOutput(width: number): string {
		const contentWidth = Math.max(1, width - SHELL_CELL_PADDING_X * 2);
		const continuationPrefixWidth = visibleWidth(COMMAND_OUTPUT_SUBSEQUENT_PREFIX);
		const outputWidth = Math.max(1, contentWidth - continuationPrefixWidth);
		return (this.bash.outputPreview ?? "")
			.split(/\r?\n/)
			.flatMap((line, index) => {
				const segments = wrapTextWithAnsi(line, outputWidth);
				return segments.map((segment, segmentIndex) => {
					const prefix = index === 0 && segmentIndex === 0
						? commandOutputInitialPrefix()
						: COMMAND_OUTPUT_SUBSEQUENT_PREFIX;
					return `${prefix}${segment}`;
				});
			})
			.join("\n");
	}

	private commandDetail(): string {
		const commandLines = this.bash.command.split(/\r?\n/);
		return [
			`${commandOutputInitialPrefix()}Command:`,
			...commandLines.map((line) => `${COMMAND_OUTPUT_SUBSEQUENT_PREFIX}${line}`),
		].join("\n");
	}

	private hiddenLinesText(hiddenCount: number): string {
		return this.bash.expanded
			? keyHint("app.tools.expand", "collapse")
			: `${uiGlyphs().ellipsis} +${hiddenCount} lines (${keyHint("app.transcript.open", "to view transcript")})`;
	}

	private indentedHiddenLinesText(hiddenCount: number): string {
		return `${COMMAND_OUTPUT_SUBSEQUENT_PREFIX}${this.hiddenLinesText(hiddenCount)}`;
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

function commandDisplayLines(command: string, headerPrefix: string, suffix: string, width: number): string[] {
	const logicalLines = command
		.split(/\r?\n/)
		.map((line) => line.replace(/\t/gu, "   ").trimEnd())
		.filter((line) => line.trim().length > 0);
	const [firstLine = "command", ...remainingLines] = logicalLines;
	const headerWidth = visibleWidth(headerPrefix);
	const firstWidth = Math.max(1, width - headerWidth);
	const firstSegments = wrapTextWithAnsi(firstLine, firstWidth);
	const continuationPrefix = commandContinuationPrefix();
	const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix));
	const continuationSegments = [
		...firstSegments.slice(1),
		...remainingLines.flatMap((line) => wrapTextWithAnsi(line, continuationWidth)),
	];
	const displayedContinuations = continuationSegments.slice(0, COMMAND_CONTINUATION_MAX_LINES);
	const omitted = continuationSegments.length - displayedContinuations.length;
	const lines = [
		`${headerPrefix}${firstSegments[0] ?? "command"}`,
		...displayedContinuations.map((line) => `${theme.fg("muted", continuationPrefix)}${line}`),
	];
	if (omitted > 0) {
		lines.push(theme.fg("muted", `${continuationPrefix}${uiGlyphs().ellipsis} +${omitted} lines`));
	}
	if (suffix) {
		const styledSuffix = theme.fg("muted", suffix);
		if (visibleWidth(`${lines[0]}${styledSuffix}`) <= width) {
			lines[0] = `${lines[0]}${styledSuffix}`;
		} else {
			lines.push(`${theme.fg("muted", continuationPrefix)}${suffix.trim()}`);
		}
	}
	return lines;
}

function commandContinuationPrefix(): string {
	return `  ${uiGlyphs().vertical} `;
}

function commandOutputInitialPrefix(): string {
	return `  ${uiGlyphs().branch} `;
}

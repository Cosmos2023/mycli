import type { MycliShellTool } from "../../model.ts";
import { terminalContent } from "../../transcript/terminal-content.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { Container } from "../../tui-core/tui.ts";
import { Spacer } from "../../tui-core/components/spacer.ts";
import { Text } from "../../tui-core/components/text.ts";
import { truncateToWidth, visibleWidth } from "../../tui-core/utils.ts";
import { TRANSCRIPT_HEADER_INDENT, TRANSCRIPT_BRANCH_INDENT } from "./transcript-gutter.ts";

/**
 * Collapses a command onto one line so a heredoc or a `\`-continued command cannot turn a single
 * wait row into a block. The row is truncated to the terminal width when it renders.
 */
function compactCommandPreview(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

export class TerminalInteractionComponent extends Container {
	private readonly header = new Text("", TRANSCRIPT_HEADER_INDENT, 0);
	private readonly headerPrefix: string;
	private readonly commandPreview: string;
	private renderedHeader: string | null = null;

	constructor(tool: MycliShellTool) {
		super();
		const interaction = tool.terminalInteraction;
		if (!interaction) {
			this.headerPrefix = "";
			this.commandPreview = "";
			return;
		}
		const running = tool.status === "running";
		const failed = interaction.interaction_succeeded !== true && (tool.status === "error" || tool.status === "cancelled");
		const interrupted = tool.status === "cancelled" || tool.errorPreview === "tool_interrupted"
			|| tool.errorPreview === "effect_outcome_unknown";
		const poll = interaction.kind === "poll";
		const label = failed
			? interrupted ? "Terminal interaction interrupted" : "Terminal interaction failed"
			: poll ? running ? "Waiting for background terminal" : "Waited for background terminal"
				: running ? "Interacting with background terminal" : "Interacted with background terminal";
		const marker = poll ? uiGlyphs().bullet : uiGlyphs().continuation;
		this.headerPrefix = `${theme.fg(failed ? "error" : "muted", marker)} ${theme.bold(label)}`;
		this.commandPreview = interaction.command_preview ? compactCommandPreview(interaction.command_preview) : "";
		this.addChild(new Spacer(1));
		this.addChild(this.header);
		if (!poll && interaction.input_preview) {
			this.addChild(new Text(theme.fg("muted", `${uiGlyphs().branch} ${terminalContent(interaction.input_preview)}`),
				TRANSCRIPT_BRANCH_INDENT, 0));
		}
		if (failed && tool.errorPreview) {
			this.addChild(new Text(theme.fg("error", `${uiGlyphs().branch} ${terminalContent(tool.errorPreview)}`),
				TRANSCRIPT_BRANCH_INDENT, 0));
		}
	}

	render(width: number): string[] {
		const header = this.headerText(width);
		if (header !== this.renderedHeader) {
			this.renderedHeader = header;
			this.header.setText(header);
		}
		return super.render(width);
	}

	/** The full command stays on the shell row; this row only has to stay readable on one line. */
	private headerText(width: number): string {
		if (!this.commandPreview) return this.headerPrefix;
		const separator = ` ${uiGlyphs().separator} `;
		const budget = width - visibleWidth(this.headerPrefix) - visibleWidth(separator);
		if (budget <= 0) return this.headerPrefix;
		const command = truncateToWidth(this.commandPreview, budget, uiGlyphs().ellipsis);
		return `${this.headerPrefix}${theme.fg("muted", `${separator}${terminalContent(command)}`)}`;
	}
}

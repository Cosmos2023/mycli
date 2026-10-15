import type { MycliShellTool } from "../../model.ts";
import { terminalContent } from "../../transcript/terminal-content.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { Container } from "../../tui-core/tui.ts";
import { Spacer } from "../../tui-core/components/spacer.ts";
import { Text } from "../../tui-core/components/text.ts";
import { TRANSCRIPT_HEADER_INDENT, TRANSCRIPT_BRANCH_INDENT } from "./transcript-gutter.ts";

/** Keeps a wait row to a single readable line; the full command stays on the shell row itself. */
const COMMAND_PREVIEW_MAX_CHARS = 72;

function compactCommandPreview(text: string): string {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	return collapsed.length > COMMAND_PREVIEW_MAX_CHARS
		? `${collapsed.slice(0, COMMAND_PREVIEW_MAX_CHARS - 1)}${uiGlyphs().ellipsis}`
		: collapsed;
}

export class TerminalInteractionComponent extends Container {
	constructor(tool: MycliShellTool) {
		super();
		const interaction = tool.terminalInteraction;
		if (!interaction) return;
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
		const command = interaction.command_preview
			? ` ${uiGlyphs().separator} ${terminalContent(compactCommandPreview(interaction.command_preview))}`
			: "";
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${theme.fg(failed ? "error" : "muted", marker)} ${theme.bold(label)}${theme.fg("muted", command)}`,
			TRANSCRIPT_HEADER_INDENT, 0));
		if (!poll && interaction.input_preview) {
			this.addChild(new Text(theme.fg("muted", `${uiGlyphs().branch} ${terminalContent(interaction.input_preview)}`),
				TRANSCRIPT_BRANCH_INDENT, 0));
		}
		if (failed && tool.errorPreview) {
			this.addChild(new Text(theme.fg("error", `${uiGlyphs().branch} ${terminalContent(tool.errorPreview)}`),
				TRANSCRIPT_BRANCH_INDENT, 0));
		}
	}
}

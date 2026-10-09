import type { GatewayAgentInteraction } from "@mycli/contracts";
import type { MycliShellTool } from "../../model.ts";
import { Container, Spacer, Text } from "../../tui-core/index.ts";
import { theme } from "../../theme/theme.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { terminalContent } from "../../transcript/terminal-content.ts";
import { keyHint } from "../shared/keybinding-hints.ts";
import { TRANSCRIPT_HEADER_INDENT, TRANSCRIPT_BRANCH_INDENT } from "./transcript-gutter.ts";
import { stripVTControlCharacters } from "node:util";

const ACTIONS: Readonly<Record<GatewayAgentInteraction["kind"], readonly [string, string, string]>> = {
	spawn: ["Starting agent", "Started agent", "Start agent"],
	message: ["Sending message to", "Sent message to", "Send message to"],
	followup: ["Assigning follow-up to", "Assigned follow-up to", "Assign follow-up to"],
	interrupt: ["Requesting stop for", "Requested stop for", "Stop request for"],
};

export class AgentInteractionComponent extends Container {
	constructor(tool: MycliShellTool) {
		super();
		const interaction = tool.agentInteraction;
		if (!interaction) return;
		const failed = tool.status === "error" || tool.status === "cancelled";
		const actions = ACTIONS[interaction.kind];
		const action = tool.status === "running" ? actions[0] : failed ? actions[2] : actions[1];
		const status = failed ? ` ${uiGlyphs().separator} ${tool.status === "cancelled" ? "cancelled" : "failed"}` : "";
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${theme.fg(failed ? "error" : "accent", uiGlyphs().continuation)} ${action} ${theme.bold(terminalContent(interaction.target))}${theme.fg(failed ? "error" : "muted", status)}`,
			TRANSCRIPT_HEADER_INDENT, 0));
		if (interaction.message_preview) {
			const preview = theme.fg("muted", `${uiGlyphs().branch} ${terminalContent(interaction.message_preview)}`);
			this.addChild(tool.expanded ? new Text(preview, TRANSCRIPT_BRANCH_INDENT, 0) : {
				render: (width: number): string[] => {
					const lines = new Text(preview, TRANSCRIPT_BRANCH_INDENT, 0).render(width);
					return lines.length > 2
						? [...lines.slice(0, 2), ...new Text(theme.fg("dim", `+ Show details (${keyHint("app.tools.expand", "expand")})`), TRANSCRIPT_BRANCH_INDENT, 0).render(width)]
						: lines;
				},
				invalidate: (): void => {},
			});
		}
		if (failed) {
			this.addChild(new Text(theme.fg("error", terminalContent(tool.errorPreview ?? tool.summaryPreview ?? tool.outputPreview ?? "Interaction did not complete")), TRANSCRIPT_BRANCH_INDENT, 0));
		}
		if (tool.expanded) {
			this.addChild(new Text(theme.fg("dim", tool.name), TRANSCRIPT_BRANCH_INDENT, 0));
			const detail = tool.detailPreview ?? tool.outputPreview ?? tool.summaryPreview;
			if (detail) this.addChild(new Text(theme.fg("muted", terminalContent(detail)), TRANSCRIPT_BRANCH_INDENT, 0));
			this.addChild(new Text(theme.fg("muted", `${uiGlyphs().minus} Show less (${keyHint("app.tools.expand", "collapse")})`), TRANSCRIPT_BRANCH_INDENT, 0));
		}
	}

	/** True when the given rendered row is this block's expand/collapse affordance. */
	isDetailsToggleRow(row: number, width: number): boolean {
		const lines = this.render(width).map((line) => stripVTControlCharacters(line));
		if (row !== lines.length - 1) return false;
		const last = lines[row] ?? "";
		return last.includes("Show details") || last.includes("Show less");
	}
}

import { FooterComponent } from "../components/composer/footer.ts";
import { WorkStatusComponent } from "../components/composer/work-status.ts";
import { StatusMessageComponent, sanitizeStatusText } from "../components/composer/status-line.ts";
import { rawKeyHint } from "../components/shared/keybinding-hints.ts";
import {
	isResolvedSubagent,
	SubagentTaskPanelComponent,
} from "../components/transcript/subagent-task-panel.ts";
import { TranscriptBlocksComponent } from "../components/transcript/transcript-renderer.ts";
import type { MycliShellState, MycliShellTranscriptBlock } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";

export class MycliShellApp extends Container {
	constructor(private readonly state: MycliShellState) {
		super();
		if (state.settings?.theme === "dark" || state.settings?.theme === "light") {
			theme.setName(state.settings.theme);
		}
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(this.headerText(), 0, 0));
		this.addChild(new TranscriptBlocksComponent(this.transcriptBlocks(), this.state.settings?.hideThinking));
		const liveState = sanitizeStatusText(this.state.footer.liveState ?? "");
		if (liveState && !["idle", "completed"].includes(liveState.toLowerCase())) {
			this.addChild(new Spacer(1));
			this.addChild(new StatusMessageComponent(liveState));
		}
		this.addChild(new WorkStatusComponent(this.state.footer));
		if (this.state.pendingNotice) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("warning", this.state.pendingNotice), 1, 0));
		}
		this.addChild(new Spacer(1));
		const agents = this.subagents();
		if (agents.length > 0) {
			this.addChild(new SubagentTaskPanelComponent({
				agents,
				density: this.state.settings?.subagentDensity ?? "normal",
			}));
		}
		this.addChild(new FooterComponent(this.state.footer, {
			statusbarMode: this.state.settings?.statusbarMode ?? "full",
		}));
	}

	private headerText(): string {
		const title = this.state.title ?? "mycli";
		return `${theme.fg("accent", theme.bold(title))} ${theme.fg("muted", rawKeyHint("?", "help"))}`;
	}

	private transcriptBlocks(): MycliShellTranscriptBlock[] {
		if (this.state.transcript?.length) {
			return this.state.transcript;
		}
		return [
			...this.state.messages.map((message) => ({ id: message.id, kind: "message" as const, message })),
			...this.state.tools.map((tool) => ({ id: tool.id, kind: "tool" as const, tool })),
			...this.state.bash.map((bash) => ({ id: bash.id, kind: "bash" as const, bash })),
		];
	}

	private subagents() {
		return this.transcriptBlocks().filter((block) => block.kind === "subagent").map((block) => block.subagent).filter((agent) => !isResolvedSubagent(agent));
	}
}

export function renderMycliShell(state: MycliShellState, width: number): string[] {
	return new MycliShellApp(state).render(width);
}

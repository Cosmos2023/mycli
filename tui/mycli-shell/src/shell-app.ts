import { Spacer } from "./tui-core/components/spacer.ts";
import { Text } from "./tui-core/components/text.ts";
import { Container } from "./tui-core/tui.ts";
import type { MycliShellMessage, MycliShellState, MycliShellTranscriptBlock } from "./model.ts";
import { theme } from "./theme/theme.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { CollapsedToolGroupComponent } from "./components/collapsed-tool-group.ts";
import { CommandDiagnosticComponent } from "./components/command-diagnostic.ts";
import { FooterComponent } from "./components/footer.ts";
import { PlanPanelComponent } from "./components/plan-panel.ts";
import { ProposedPlanComponent } from "./components/proposed-plan.ts";
import { SubagentExecutionComponent, SubagentGroupComponent } from "./components/subagent-execution.ts";
import { isResolvedSubagent, SubagentTaskPanelComponent } from "./components/subagent-task-panel.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { rawKeyHint } from "./components/keybinding-hints.ts";
import { projectTranscriptBlocks } from "./transcript-projection.ts";

export class MycliShellApp extends Container {
	constructor(private readonly state: MycliShellState) {
		super();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(this.headerText(), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new TranscriptBlocksComponent(this.transcriptBlocks()));
		if (this.state.pendingNotice) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("warning", this.state.pendingNotice), 1, 0));
		}
		if (this.state.activePlan?.length) {
			this.addChild(new Spacer(1));
			this.addChild(new PlanPanelComponent(this.state.activePlan));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.composerHint(), 1, 0));
		const agents = this.subagents();
		if (agents.length > 0) {
			this.addChild(new SubagentTaskPanelComponent({ agents }));
		}
		this.addChild(new FooterComponent(this.state.footer));
	}

	private headerText(): string {
		const title = this.state.title ?? "mycli";
		return `${theme.fg("accent", theme.bold(title))} ${theme.fg("muted", rawKeyHint("ctrl+p", "commands"))} ${theme.fg("muted", rawKeyHint("ctrl+l", "model"))}`;
	}

	private composerHint(): string {
		return `${theme.fg("dim", "▸")} ${theme.fg("muted", "Message mycli")}  ${rawKeyHint("enter", "send")}  ${rawKeyHint("alt+enter", "queue")}`;
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

class TranscriptBlocksComponent extends Container {
	constructor(private readonly blocks: MycliShellTranscriptBlock[]) {
		super();
		this.rebuild();
	}

	private rebuild(): void {
		for (const block of projectTranscriptBlocks(this.blocks)) {
			if (block.kind === "message") {
				this.addMessageBlock(block.message);
			} else if (block.kind === "plan") {
				this.addChild(new ProposedPlanComponent(block.plan));
			} else if (block.kind === "tool") {
				this.addChild(new ToolExecutionComponent(block.tool));
			} else if (block.kind === "bash") {
				this.addChild(new BashExecutionComponent(block.bash));
			} else if (block.kind === "subagent") {
				this.addChild(new SubagentExecutionComponent(block.subagent));
			} else if (block.kind === "diagnostic") {
				this.addChild(new CommandDiagnosticComponent(block.diagnostic));
			} else if (block.kind === "agent_group") {
				this.addChild(new SubagentGroupComponent(block.group));
			} else if (block.kind === "tool_group") {
				this.addChild(new CollapsedToolGroupComponent(block.group));
			}
		}
	}

	private addMessageBlock(message: MycliShellMessage): void {
		if (message.role === "user") {
			this.addChild(new UserMessageComponent(message.text));
		} else if (message.role === "assistant") {
			this.addChild(new AssistantMessageComponent(message.text, message.thinking, message.thinkingHidden ?? true));
		} else {
			const color = message.role === "error" ? "error" : message.role === "warning" ? "warning" : "muted";
			this.addChild(new Text(theme.fg(color, message.text), 1, 0));
		}
	}
}

export function renderMycliShell(state: MycliShellState, width: number): string[] {
	return new MycliShellApp(state).render(width);
}

export function renderTranscriptBlocks(blocks: MycliShellTranscriptBlock[], width: number): string[] {
	return new TranscriptBlocksComponent(blocks).render(width);
}

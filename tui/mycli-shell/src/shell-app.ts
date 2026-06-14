import { Spacer } from "./tui-core/components/spacer.ts";
import { Text } from "./tui-core/components/text.ts";
import { Container } from "./tui-core/tui.ts";
import type { MycliShellMessage, MycliShellState } from "./model.ts";
import { theme } from "./theme/theme.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { FooterComponent } from "./components/footer.ts";
import { PlanPanelComponent } from "./components/plan-panel.ts";
import { ProposedPlanComponent } from "./components/proposed-plan.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { rawKeyHint } from "./components/keybinding-hints.ts";

export class MycliShellApp extends Container {
	constructor(private readonly state: MycliShellState) {
		super();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(this.headerText(), 0, 0));
		this.addChild(new Spacer(1));
		if (this.state.transcript?.length) {
			for (const block of this.state.transcript) {
				if (block.kind === "message") {
					this.addMessageBlock(block.message);
				} else if (block.kind === "plan") {
					this.addChild(new ProposedPlanComponent(block.plan));
				} else if (block.kind === "tool") {
					this.addChild(new ToolExecutionComponent(block.tool));
				} else {
					this.addChild(new BashExecutionComponent(block.bash));
				}
			}
		} else {
			for (const message of this.state.messages) {
				this.addMessageBlock(message);
			}
			for (const tool of this.state.tools) {
				this.addChild(new ToolExecutionComponent(tool));
			}
			for (const bash of this.state.bash) {
				this.addChild(new BashExecutionComponent(bash));
			}
		}
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
		this.addChild(new FooterComponent(this.state.footer));
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

	private headerText(): string {
		const title = this.state.title ?? "mycli";
		return `${theme.fg("accent", theme.bold(title))} ${theme.fg("muted", rawKeyHint("ctrl+p", "commands"))} ${theme.fg("muted", rawKeyHint("ctrl+l", "model"))}`;
	}

	private composerHint(): string {
		return `${theme.fg("dim", "▸")} ${theme.fg("muted", "Message mycli")}  ${rawKeyHint("enter", "send")}  ${rawKeyHint("alt+enter", "queue")}`;
	}
}

export function renderMycliShell(state: MycliShellState, width: number): string[] {
	return new MycliShellApp(state).render(width);
}

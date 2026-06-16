import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellSubagent } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { shortPreview } from "./tool-display.ts";

export type SubagentGroup = {
	id: string;
	agents: MycliShellSubagent[];
};

export class SubagentExecutionComponent extends Container {
	private subagent: MycliShellSubagent;

	constructor(subagent: MycliShellSubagent) {
		super();
		this.subagent = subagent;
		this.rebuild();
	}

	updateSubagent(subagent: MycliShellSubagent): void {
		this.subagent = subagent;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		if (isBackgroundNotification(this.subagent)) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(notificationText(this.subagent), 1, 0));
			return;
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.headerText(), 1, 0));
		this.addChild(new Text(agentLine(this.subagent, true), 3, 0));
		for (const line of agentProgressLines(this.subagent, true)) {
			this.addChild(new Text(line, 3, 0));
		}
	}

	private headerText(): string {
		const color = this.statusColor();
		const label = isResolved(this.subagent) ? "Agent finished" : "Running agent...";
		return `${theme.fg(color, theme.bold("⏺"))} ${theme.fg(color, theme.bold(label))}`;
	}

	private statusColor(): "accent" | "success" | "error" | "warning" {
		const normalized = this.subagent.status.toLowerCase();
		if (normalized === "running") return "warning";
		if (normalized === "failed" || normalized === "error") return "error";
		if (normalized === "completed" || normalized === "success") return "success";
		return "accent";
	}
}

export class SubagentGroupComponent extends Container {
	private group: SubagentGroup;

	constructor(group: SubagentGroup) {
		super();
		this.group = group;
		this.rebuild();
	}

	updateGroup(group: SubagentGroup): void {
		this.group = group;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.headerText(), 1, 0));
		this.group.agents.forEach((agent, index) => {
			const isLast = index === this.group.agents.length - 1;
			this.addChild(new Text(agentLine(agent, isLast), 3, 0));
			for (const line of agentProgressLines(agent, isLast)) {
				this.addChild(new Text(line, 3, 0));
			}
		});
	}

	private headerText(): string {
		const count = this.group.agents.length;
		const running = this.group.agents.some((agent) => !isResolved(agent));
		const failed = this.group.agents.some((agent) => isFailed(agent));
		const allAsync = this.group.agents.every((agent) => agent.mode === "background");
		const color = failed ? "error" : running ? "warning" : "success";
		const label = running
			? `Running ${count} agents...`
			: allAsync
				? `${count} background agents launched`
				: `${count} agents finished`;
		return `${theme.fg(color, theme.bold("⏺"))} ${theme.fg(color, theme.bold(label))}`;
	}
}

function agentLine(agent: MycliShellSubagent, isLast: boolean): string {
	const marker = isLast ? "└─" : "├─";
	const description = agent.description ? ` (${agent.description})` : "";
	const stats = agentStats(agent);
	const color = isFailed(agent) ? "error" : isResolved(agent) ? "muted" : "warning";
	return theme.fg(color, `${marker} ${agent.role}${description}${stats ? ` · ${stats}` : ""}`);
}

function agentProgressLines(agent: MycliShellSubagent, isLast: boolean): string[] {
	const progress = (agent.progress ?? []).filter((item) => item.kind !== "final").slice(-3);
	if (!progress.length) {
		return [agentStatusLine(agent, isLast, undefined)];
	}
	return progress.map((item) => agentStatusLine(agent, isLast, item.summary ?? item.toolName ?? item.kind));
}

function agentStatusLine(agent: MycliShellSubagent, isLast: boolean, overrideText: string | undefined): string {
	const prefix = isLast ? "   ⎿ " : "│  ⎿ ";
	const text = overrideText ?? agent.error ?? (!isResolved(agent) ? agent.summary : undefined) ?? (isResolved(agent) ? "Done" : "Initializing...");
	const color = isFailed(agent) ? "error" : "muted";
	return theme.fg(color, `${prefix}${shortPreview(text, 100) ?? ""}`);
}

function agentStats(agent: MycliShellSubagent): string {
	const parts = [];
	if (agent.toolCalls !== undefined) {
		parts.push(`${agent.toolCalls} tool ${agent.toolCalls === 1 ? "use" : "uses"}`);
	}
	if (agent.tokens !== undefined) {
		parts.push(`${formatNumber(agent.tokens)} tokens`);
	}
	if (agent.durationMs !== undefined && isResolved(agent)) {
		parts.push(formatDuration(agent.durationMs));
	}
	return parts.join(" · ");
}

function notificationText(agent: MycliShellSubagent): string {
	const color = isFailed(agent) ? "error" : agent.status === "cancelled" ? "warning" : "success";
	const summary = agent.summary || `Agent "${agent.description ?? agent.role}" ${isFailed(agent) ? "failed" : "completed"}`;
	return `${theme.fg(color, "●")} ${summary}`;
}

function isBackgroundNotification(agent: MycliShellSubagent): boolean {
	return agent.mode === "background" && isResolved(agent);
}

function isResolved(agent: MycliShellSubagent): boolean {
	const normalized = agent.status.toLowerCase();
	return !["running", "pending", "queued"].includes(normalized);
}

function isFailed(agent: MycliShellSubagent): boolean {
	const normalized = agent.status.toLowerCase();
	return normalized === "failed" || normalized === "error" || normalized === "max_tool_calls";
}

function formatNumber(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

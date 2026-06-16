import type { MycliShellSubagent } from "../model.ts";
import type { Component } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../tui-core/utils.ts";
import { theme } from "../theme/theme.ts";
import { shortPreview } from "./tool-display.ts";

export type SubagentTaskPanelMode = "compact" | "expanded";

export type SubagentTaskPanelOptions = {
	agents: MycliShellSubagent[];
	mode: SubagentTaskPanelMode;
	selectedIndex: number;
	viewingSubagentId?: string | null;
};

export class SubagentTaskPanelComponent implements Component {
	constructor(private readonly options: SubagentTaskPanelOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.options.agents.length === 0) {
			return [];
		}
		return this.options.mode === "expanded" ? this.renderExpanded(width) : this.renderCompact(width);
	}

	private renderCompact(width: number): string[] {
		const running = this.options.agents.filter((agent) => !isResolved(agent)).length;
		const failed = this.options.agents.filter(isFailed).length;
		const viewed = this.options.viewingSubagentId ? this.options.agents.find((agent) => agent.id === this.options.viewingSubagentId) : null;
		const agentNames = compactAgentNames(this.options.agents, width);
		const state =
			viewed
				? `view @${viewed.role}`
				: running > 0
					? `${running} running`
					: failed > 0
						? `${failed} failed`
						: `${this.options.agents.length} done`;
		const text = `${theme.fg("accent", "agents")} ${agentNames} ${theme.fg("muted", `· ${state} · shift+↓ manage`)}`;
		return [truncateToWidth(` ${text}`, width, theme.fg("muted", "..."))];
	}

	private renderExpanded(width: number): string[] {
		const lines: string[] = [truncateToWidth(theme.fg("muted", " agents · ↑↓ select · enter view · x clear · esc close"), width)];
		lines.push(this.renderMainRow(width));
		this.options.agents.forEach((agent, index) => {
			lines.push(this.renderAgentRow(agent, index + 1, width));
			if (this.options.selectedIndex === index + 1) {
				const detail = selectedAgentDetail(agent, width);
				if (detail) {
					lines.push(detail);
				}
			}
		});
		return lines;
	}

	private renderMainRow(width: number): string {
		const selected = this.options.selectedIndex === 0;
		const viewingMain = !this.options.viewingSubagentId;
		const pointer = selected ? theme.fg("accent", "›") : " ";
		const marker = viewingMain ? theme.fg("accent", "●") : theme.fg("muted", "○");
		const label = `${pointer} ${marker} main`;
		return truncateToWidth(` ${selected ? theme.inverse(label) : label}`, width);
	}

	private renderAgentRow(agent: MycliShellSubagent, index: number, width: number): string {
		const selected = this.options.selectedIndex === index;
		const viewing = this.options.viewingSubagentId === agent.id;
		const pointer = selected ? theme.fg("accent", "›") : " ";
		const marker = viewing ? theme.fg("accent", "●") : theme.fg("muted", "○");
		const activity = isResolved(agent) ? theme.fg(agentStatusColor(agent), "⏸") : theme.fg("warning", "▶");
		const label = shortPreview(agent.description ? `${agent.role}: ${agent.description}` : agent.role, 52) ?? agent.role;
		const stats = agentStats(agent);
		const clearHint = selected && isResolved(agent) ? theme.fg("muted", " · x to clear") : "";
		const row = `${pointer} ${marker} ${label} ${activity}${stats ? ` ${theme.fg("muted", stats)}` : ""}${clearHint}`;
		return truncateToWidth(` ${selected ? theme.inverse(row) : row}`, width);
	}
}

function compactAgentNames(agents: MycliShellSubagent[], width: number): string {
	const budget = Math.max(12, Math.min(48, width - 28));
	const names: string[] = [];
	for (const agent of agents) {
		const candidate = [...names, `@${agent.role}`].join(" ");
		if (visibleWidth(candidate) > budget) {
			break;
		}
		names.push(`@${agent.role}`);
	}
	if (names.length === agents.length) {
		return names.join(" ");
	}
	const remaining = agents.length - names.length;
	return `${names.join(" ")} +${remaining}`.trim();
}

function selectedAgentDetail(agent: MycliShellSubagent, width: number): string | null {
	const progress = (agent.progress ?? []).filter((item) => item.kind !== "final");
	const latest = progress.at(-1);
	const detail = latest?.summary ?? latest?.toolName ?? agent.error ?? agent.summary;
	if (!detail) {
		return null;
	}
	return truncateToWidth(theme.fg("muted", `   ⎿ ${shortPreview(detail, 96) ?? ""}`), width);
}

function agentStats(agent: MycliShellSubagent): string {
	const parts: string[] = [];
	if (agent.durationMs !== undefined) {
		parts.push(formatDuration(agent.durationMs));
	}
	if (agent.tokens !== undefined) {
		parts.push(`↓ ${formatNumber(agent.tokens)} tokens`);
	}
	if (agent.toolCalls !== undefined) {
		parts.push(`${agent.toolCalls} tools`);
	}
	return parts.length > 0 ? `· ${parts.join(" · ")}` : "";
}

function isResolved(agent: MycliShellSubagent): boolean {
	const normalized = agent.status.toLowerCase();
	return !["running", "pending", "queued"].includes(normalized);
}

function isFailed(agent: MycliShellSubagent): boolean {
	const normalized = agent.status.toLowerCase();
	return normalized === "failed" || normalized === "error" || normalized === "max_tool_calls";
}

function agentStatusColor(agent: MycliShellSubagent): "success" | "error" | "warning" | "muted" {
	if (isFailed(agent)) return "error";
	if (agent.status === "cancelled") return "warning";
	if (isResolved(agent)) return "success";
	return "muted";
}

function formatNumber(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${Math.round(ms / 1000)}s`;
}

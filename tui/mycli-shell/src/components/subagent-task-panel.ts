import type { MycliShellSubagent, MycliShellVisualSettings } from "../model.ts";
import { Container, getKeybindings, Spacer, Text, type TUI, truncateToWidth, visibleWidth } from "../tui-core/index.ts";
import type { Component } from "../tui-core/tui.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { rawKeyHint } from "./keybinding-hints.ts";
import { shortPreview } from "./tool-display.ts";

export type SubagentTaskPanelOptions = {
	agents: MycliShellSubagent[];
	onOpen?: () => void;
	density?: NonNullable<MycliShellVisualSettings["subagentDensity"]>;
};

export type BackgroundSubagentDialogOptions = {
	tui: TUI;
	agents: MycliShellSubagent[];
	onBack: () => void;
	onClear: (agent: MycliShellSubagent) => void;
	onStop: (agent: MycliShellSubagent) => void;
	onForeground?: (agent: MycliShellSubagent) => void;
	initialDetailSubagentId?: string;
};

type DialogViewState = { mode: "list" } | { mode: "detail"; subagentId: string };

export class SubagentTaskPanelComponent implements Component {
	constructor(private readonly options: SubagentTaskPanelOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.options.agents.length === 0) {
			return [];
		}
		const density = this.options.density ?? "normal";
		const hint = density === "compact" ? "" : ` ${theme.fg("muted", `${uiGlyphs().separator} ${rawKeyHint("/tasks", "view")}`)}`;
		const text = `${theme.fg("accent", uiGlyphs().diamond)} ${theme.fg("accent", pillLabel(this.options.agents))}${hint}`;
		const lines = [truncateToWidth(` ${text}`, width, theme.fg("muted", "..."))];
		if (density !== "detailed") return lines;

		const visible = sortedAgents(this.options.agents).slice(0, 3);
		for (const [index, agent] of visible.entries()) {
			lines.push(truncateToWidth(`   ${agentListLine(agent, false, index === visible.length - 1)}`, width, theme.fg("muted", "...")));
		}
		if (this.options.agents.length > visible.length) {
			lines.push(truncateToWidth(theme.fg("muted", `   ... ${this.options.agents.length - visible.length} more`), width, "..."));
		}
		return lines;
	}

	handleInput(data: string): void {
		if (data === "\r" || data === "\n") {
			this.options.onOpen?.();
		}
	}
}

export class BackgroundSubagentDialogComponent extends Container {
	private readonly tui: TUI;
	private agents: MycliShellSubagent[];
	private selectedIndex = 0;
	private skippedListOnMount = false;
	private viewState: DialogViewState = { mode: "list" };
	private readonly onBack: () => void;
	private readonly onClear: (agent: MycliShellSubagent) => void;
	private readonly onStop: (agent: MycliShellSubagent) => void;
	private readonly onForeground?: (agent: MycliShellSubagent) => void;

	constructor(options: BackgroundSubagentDialogOptions) {
		super();
		this.tui = options.tui;
		this.agents = sortedAgents(options.agents);
		this.onBack = options.onBack;
		this.onClear = options.onClear;
		this.onStop = options.onStop;
		this.onForeground = options.onForeground;
		const initialId = options.initialDetailSubagentId ?? (this.agents.length === 1 ? this.agents[0]?.id : undefined);
		if (initialId && this.agents.some((agent) => agent.id === initialId)) {
			this.viewState = { mode: "detail", subagentId: initialId };
			this.skippedListOnMount = true;
		}
		this.rebuild();
	}

	updateAgents(agents: MycliShellSubagent[]): void {
		this.agents = sortedAgents(agents);
		const detailId = this.viewState.mode === "detail" ? this.viewState.subagentId : null;
		if (detailId && !this.agents.some((agent) => agent.id === detailId)) {
			this.viewState = { mode: "list" };
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.agents.length - 1));
		this.rebuild();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.viewState.mode === "detail") {
			this.handleDetailInput(data, kb);
			return;
		}
		if (kb.matches(data, "tui.select.cancel") || data === "\x1b[D") {
			this.onBack();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			if (this.agents.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.agents.length - 1 : this.selectedIndex - 1;
				this.rebuildAndRender();
			}
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.agents.length > 0) {
				this.selectedIndex = this.selectedIndex === this.agents.length - 1 ? 0 : this.selectedIndex + 1;
				this.rebuildAndRender();
			}
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.agents[this.selectedIndex];
			if (selected) {
				this.viewState = { mode: "detail", subagentId: selected.id };
				this.rebuildAndRender();
			}
			return;
		}
		if (data === "x" || data === "X") {
			const selected = this.agents[this.selectedIndex];
			if (selected) {
				this.runAgentAction(selected);
			}
			return;
		}
		if (data === "f" || data === "F") {
			const selected = this.agents[this.selectedIndex];
			if (selected && !isResolved(selected)) {
				this.onForeground?.(selected);
			}
		}
	}

	private handleDetailInput(data: string, kb: ReturnType<typeof getKeybindings>): void {
		const agent = this.currentDetailAgent();
		if (!agent) {
			this.viewState = { mode: "list" };
			this.rebuildAndRender();
			return;
		}
		if (data === "\x1b[D") {
			this.goBackToList();
			return;
		}
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm") || data === " ") {
			this.onBack();
			return;
		}
		if (data === "x" || data === "X") {
			this.runAgentAction(agent);
			return;
		}
		if ((data === "f" || data === "F") && !isResolved(agent)) {
			this.onForeground?.(agent);
		}
	}

	private runAgentAction(agent: MycliShellSubagent): void {
		if (isResolved(agent)) {
			this.onClear(agent);
			this.agents = this.agents.filter((item) => item.id !== agent.id);
			if (this.viewState.mode === "detail" && this.viewState.subagentId === agent.id) {
				this.goBackAfterRemoval();
			}
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.agents.length - 1));
			this.rebuildAndRender();
			return;
		}
		this.onStop(agent);
	}

	private goBackAfterRemoval(): void {
		if (this.skippedListOnMount && this.agents.length <= 1) {
			this.onBack();
			return;
		}
		this.skippedListOnMount = false;
		this.viewState = { mode: "list" };
	}

	private goBackToList(): void {
		if (this.skippedListOnMount && this.agents.length <= 1) {
			this.onBack();
			return;
		}
		this.skippedListOnMount = false;
		this.viewState = { mode: "list" };
		this.rebuildAndRender();
	}

	private currentDetailAgent(): MycliShellSubagent | undefined {
		if (this.viewState.mode !== "detail") {
			return undefined;
		}
		const detailId = this.viewState.subagentId;
		return this.agents.find((agent) => agent.id === detailId);
	}

	private rebuildAndRender(): void {
		this.rebuild();
		this.tui.requestRender();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		if (this.viewState.mode === "detail") {
			this.addDetailChildren();
		} else {
			this.addListChildren();
		}
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private addListChildren(): void {
		const title = theme.fg("selectorTitle", theme.bold("Agent tree"));
		const subtitle = theme.fg("selectorMeta", backgroundSummary(this.agents));
		this.addChild(renderLines((width) => [fitHeader(title, subtitle, width)]));
		this.addChild(new Text(listGuide(this.currentSelection()), 0, 0));
		this.addChild(new Spacer(1));
		if (this.agents.length === 0) {
			this.addChild(new Text(theme.fg("selectorMeta", "  No agents in this session"), 0, 0));
			return;
		}
		this.addChild(new Text(theme.fg("selectorMeta", theme.bold("  Agents")), 0, 0));
		const maxVisible = 10;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.agents.length - maxVisible));
		for (let index = startIndex; index < Math.min(this.agents.length, startIndex + maxVisible); index += 1) {
			const agent = this.agents[index];
			if (!agent) continue;
			this.addChild(new Text(agentListLine(
				agent,
				index === this.selectedIndex,
				isLastSibling(this.agents, index),
			), 0, 0));
		}
		if (this.agents.length > maxVisible) {
			this.addChild(new Text(theme.fg("selectorMeta", `  (${this.selectedIndex + 1}/${this.agents.length})`), 0, 0));
		}
	}

	private addDetailChildren(): void {
		const agent = this.currentDetailAgent();
		if (!agent) {
			this.addChild(new Text(theme.fg("selectorMeta", "  Task is no longer available"), 0, 0));
			return;
		}
		const title = theme.fg("selectorTitle", theme.bold(`${agent.role} ${uiGlyphs().selector} ${agent.description ?? "Async agent"}`));
		const subtitle = theme.fg("selectorMeta", agentSubtitle(agent));
		this.addChild(renderLines((width) => [fitHeader(title, subtitle, width)]));
		this.addChild(new Text(detailGuide(agent), 0, 0));
		this.addChild(new Spacer(1));
		const progress = (agent.progress ?? []).filter((item) => item.kind !== "final");
		if (progress.length > 0 && !isResolved(agent)) {
			this.addChild(new Text(theme.fg("selectorMeta", theme.bold("  Progress")), 0, 0));
			for (const item of progress.slice(-8)) {
				const detail = item.summary ?? item.toolName ?? item.kind;
				this.addChild(new Text(theme.fg("muted", `  ${detail === progress.at(-1)?.summary ? uiGlyphs().selector : " "} ${shortPreview(detail, 96) ?? ""}`), 0, 0));
			}
			this.addChild(new Spacer(1));
		}
		this.addChild(new Text(theme.fg("selectorMeta", theme.bold("  Prompt")), 0, 0));
		this.addChild(new Text(theme.fg("muted", `  ${shortPreview(agent.description ?? agent.summary ?? agent.role, 120) ?? ""}`), 0, 0));
		if (agent.error) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("error", theme.bold("  Error")), 0, 0));
			this.addChild(new Text(theme.fg("error", `  ${shortPreview(agent.error, 120) ?? ""}`), 0, 0));
		} else if (agent.summary) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("selectorMeta", theme.bold("  Result")), 0, 0));
			this.addChild(new Text(theme.fg("muted", `  ${shortPreview(agent.summary, 120) ?? ""}`), 0, 0));
		}
	}

	private currentSelection(): MycliShellSubagent | undefined {
		return this.agents[this.selectedIndex];
	}
}

function sortedAgents(agents: MycliShellSubagent[]): MycliShellSubagent[] {
	return [...agents].sort((left, right) => {
		const leftPath = left.agentPath ?? `/root/${left.id}`;
		const rightPath = right.agentPath ?? `/root/${right.id}`;
		const pathOrder = leftPath.localeCompare(rightPath);
		if (pathOrder !== 0) return pathOrder;
		return (right.startedAt ?? "").localeCompare(left.startedAt ?? "");
	});
}

function pillLabel(agents: MycliShellSubagent[]): string {
	const running = agents.filter((agent) => !isResolved(agent)).length;
	if (running > 0) {
		return running === 1 ? "1 local agent" : `${running} local agents`;
	}
	return agents.length === 1 ? "1 local agent" : `${agents.length} local agents`;
}

function backgroundSummary(agents: MycliShellSubagent[]): string {
	const running = agents.filter((agent) => !isResolved(agent)).length;
	const failed = agents.filter(isFailed).length;
	const done = agents.length - running - failed;
	const parts = [];
	if (running > 0) parts.push(`${running} ${running === 1 ? "agent" : "agents"}`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (done > 0) parts.push(`${done} done`);
	return parts.join(` ${uiGlyphs().separator} `) || "No active agents";
}

function listGuide(agent: MycliShellSubagent | undefined): string {
	const actions = [
		rawKeyHint(`${uiGlyphs().up}/${uiGlyphs().down}`, "select"),
		rawKeyHint("Enter", "view"),
		agent && !isResolved(agent) ? rawKeyHint("x", "stop") : undefined,
		agent && isResolved(agent) ? rawKeyHint("x", "clear") : undefined,
		agent && !isResolved(agent) ? rawKeyHint("f", "foreground") : undefined,
		rawKeyHint(`${uiGlyphs().left}/Esc`, "close"),
	].filter(Boolean);
	return truncateToWidth(` ${actions.join(theme.fg("muted", ` ${uiGlyphs().separator} `))}`, 120, "...");
}

function detailGuide(agent: MycliShellSubagent): string {
	const actions = [
		rawKeyHint(uiGlyphs().left, "go back"),
		rawKeyHint("Esc/Enter/Space", "close"),
		!isResolved(agent) ? rawKeyHint("x", "stop") : undefined,
		!isResolved(agent) ? rawKeyHint("f", "foreground") : undefined,
		isResolved(agent) ? rawKeyHint("x", "clear") : undefined,
	].filter(Boolean);
	return truncateToWidth(` ${actions.join(theme.fg("muted", ` ${uiGlyphs().separator} `))}`, 120, "...");
}

function agentListLine(
	agent: MycliShellSubagent,
	selected: boolean,
	lastSibling: boolean,
): string {
	const prefix = selected ? theme.fg("selectorMatch", `${uiGlyphs().arrow} `) : "  ";
	const tree = agentTreePrefix(agent, lastSibling);
	const identity = agent.agentPath ?? agent.nickname ?? agent.taskName ?? agent.role;
	const label = `${tree}${identity}: ${agent.description ?? "Async agent"}`;
	const status = taskStatusText(agent);
	const stats = agentStats(agent);
	const row = `${prefix}${shortPreview(label, 52) ?? label} ${status}${stats ? ` ${theme.fg("selectorMeta", stats)}` : ""}`;
	return selected ? theme.inverse(row) : row;
}

function agentTreePrefix(agent: MycliShellSubagent, lastSibling: boolean): string {
	const depth = Math.max(0, (agent.agentPath?.split("/").filter(Boolean).length ?? 2) - 2);
	return `${"  ".repeat(depth)}${lastSibling ? uiGlyphs().branch : uiGlyphs().teeLeft}${uiGlyphs().horizontal} `;
}

function isLastSibling(agents: readonly MycliShellSubagent[], index: number): boolean {
	const current = agents[index];
	if (!current) return true;
	const parent = current.parentThreadId ?? parentAgentPath(current.agentPath);
	return !agents.slice(index + 1).some((candidate) => (
		(candidate.parentThreadId ?? parentAgentPath(candidate.agentPath)) === parent
	));
}

function parentAgentPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const separator = path.lastIndexOf("/");
	return separator <= 0 ? undefined : path.slice(0, separator);
}

function taskStatusText(agent: MycliShellSubagent): string {
	const normalized = agent.status.toLowerCase();
	if (normalized === "running" || normalized === "pending" || normalized === "queued" || normalized === "waiting") {
		return theme.fg("warning", "running");
	}
	if (normalized === "completed" || normalized === "success") {
		return theme.fg("success", "done");
	}
	if (normalized === "cancelled" || normalized === "killed") {
		return theme.fg("warning", "stopped");
	}
	return theme.fg("error", "failed");
}

function agentSubtitle(agent: MycliShellSubagent): string {
	const parts = [isResolved(agent) ? taskStatusText(agent) : theme.fg("warning", "running")];
	if (agent.durationMs !== undefined) parts.push(formatDuration(agent.durationMs));
	if (agent.tokens !== undefined) parts.push(`${formatNumber(agent.tokens)} tokens`);
	if (agent.toolCalls !== undefined) parts.push(`${agent.toolCalls} ${agent.toolCalls === 1 ? "tool" : "tools"}`);
	return parts.join(theme.fg("selectorMeta", ` ${uiGlyphs().separator} `));
}

function agentStats(agent: MycliShellSubagent): string {
	const parts: string[] = [];
	if (agent.durationMs !== undefined) {
		parts.push(formatDuration(agent.durationMs));
	}
	if (agent.tokens !== undefined) {
		parts.push(`${formatNumber(agent.tokens)} tokens`);
	}
	if (agent.toolCalls !== undefined) {
		parts.push(`${agent.toolCalls} ${agent.toolCalls === 1 ? "tool" : "tools"}`);
	}
	return parts.length > 0 ? `${uiGlyphs().separator} ${parts.join(` ${uiGlyphs().separator} `)}` : "";
}

function fitHeader(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
}

function renderLines(render: (width: number) => string[]): Component {
	return {
		render,
		invalidate: () => {},
	};
}

export function isResolvedSubagent(agent: MycliShellSubagent): boolean {
	const normalized = agent.status.toLowerCase();
	return !["running", "pending", "queued", "waiting"].includes(normalized);
}

function isResolved(agent: MycliShellSubagent): boolean {
	return isResolvedSubagent(agent);
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
	return `${Math.round(ms / 1000)}s`;
}

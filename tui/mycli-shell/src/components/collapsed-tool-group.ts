import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellBash, MycliShellTool, MycliShellToolStatus } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import { shortPreview } from "./tool-display.ts";

export type CollapsedToolGroupItem =
	| { kind: "tool"; tool: MycliShellTool }
	| { kind: "bash"; bash: MycliShellBash };

export type CollapsedToolGroup = {
	id: string;
	items: CollapsedToolGroupItem[];
};

export class CollapsedToolGroupComponent extends Container {
	private group: CollapsedToolGroup;

	constructor(group: CollapsedToolGroup) {
		super();
		this.group = group;
		this.rebuild();
	}

	updateGroup(group: CollapsedToolGroup): void {
		this.group = group;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		if (this.expanded()) {
			for (const item of this.group.items) {
				this.addChild(item.kind === "tool" ? new ToolExecutionComponent(item.tool) : new BashExecutionComponent(item.bash));
			}
			return;
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.headerText(), 1, 0));
		const target = this.firstTarget();
		if (target) {
			this.addChild(new Text(theme.fg("muted", `⎿ ${target}`), 3, 0));
		}
		this.addChild(new Text(theme.fg("muted", `... ${keyHint("app.tools.expand", "to expand")}`), 3, 0));
	}

	private expanded(): boolean {
		return this.group.items.some((item) => (item.kind === "tool" ? item.tool.expanded : item.bash.expanded));
	}

	private headerText(): string {
		const status = aggregateStatus(this.group.items);
		const color = status === "error" ? "error" : "accent";
		const action = status === "running" ? presentSummary(this.group.items) : pastSummary(this.group.items);
		const suffix = statusSuffix(status);
		return `${theme.fg(color, theme.bold("⏺"))} ${theme.fg(color, theme.bold(`${action}${suffix}`))}`;
	}

	private firstTarget(): string | undefined {
		for (const item of this.group.items) {
			const target = item.kind === "tool" ? shortPreview(item.tool.args) : shortPreview(item.bash.command);
			if (target) {
				return target;
			}
		}
		return undefined;
	}
}

function aggregateStatus(items: CollapsedToolGroupItem[]): MycliShellToolStatus {
	if (items.some((item) => itemStatus(item) === "error")) return "error";
	if (items.some((item) => itemStatus(item) === "running")) return "running";
	if (items.some((item) => itemStatus(item) === "cancelled")) return "cancelled";
	return "success";
}

function itemStatus(item: CollapsedToolGroupItem): MycliShellToolStatus {
	return item.kind === "tool" ? item.tool.status : item.bash.status;
}

function presentSummary(items: CollapsedToolGroupItem[]): string {
	return joinParts([
		countPhrase(countToolNames(items, ["read"]), "Reading", "file"),
		countPhrase(countToolNames(items, ["grep", "search"]), "searching", "pattern"),
		countPhrase(countToolNames(items, ["glob"]), "matching", "glob"),
		countPhrase(countToolNames(items, ["ls", "list"]), "listing", "directory"),
		countPhrase(countContextBash(items), "running", "command"),
	]) || "Gathering context";
}

function pastSummary(items: CollapsedToolGroupItem[]): string {
	return joinParts([
		countPhrase(countToolNames(items, ["read"]), "Read", "file"),
		countPhrase(countToolNames(items, ["grep", "search"]), "searched", "pattern"),
		countPhrase(countToolNames(items, ["glob"]), "matched", "glob"),
		countPhrase(countToolNames(items, ["ls", "list"]), "listed", "directory"),
		countPhrase(countContextBash(items), "ran", "command"),
	]) || "Gathered context";
}

function countToolNames(items: CollapsedToolGroupItem[], names: string[]): number {
	const allowed = new Set(names);
	return items.filter((item) => item.kind === "tool" && allowed.has(normalizeToolName(item.tool.name))).length;
}

function countContextBash(items: CollapsedToolGroupItem[]): number {
	return items.filter((item) => item.kind === "bash").length;
}

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase().replace(/[_-]/g, "");
}

function countPhrase(count: number, verb: string, noun: string): string | undefined {
	if (count <= 0) {
		return undefined;
	}
	return `${verb} ${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinParts(parts: Array<string | undefined>): string {
	return parts.filter((part): part is string => Boolean(part)).join(", ");
}

function statusSuffix(status: MycliShellToolStatus): string {
	switch (status) {
		case "running":
			return " · Running";
		case "error":
			return " · Failed";
		case "cancelled":
			return " · Cancelled";
		case "success":
			return "";
	}
}

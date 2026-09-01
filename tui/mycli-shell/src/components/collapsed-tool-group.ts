import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../tui-core/utils.ts";
import type { MycliShellBash, MycliShellTool, MycliShellToolStatus } from "../model.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import { compactPathPreview, isReadToolName, sanitizeInline } from "./tool-display.ts";
import { TRANSCRIPT_BRANCH_INDENT, TRANSCRIPT_HEADER_INDENT } from "./transcript-gutter.ts";

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

	override getRenderCacheKey(): number | undefined {
		const hasRunningShell = this.group.items.some(
			(item) => item.kind === "bash" && item.bash.status === "running",
		);
		return hasRunningShell ? undefined : super.getRenderCacheKey();
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
		this.addChild(new Text(this.headerText(), TRANSCRIPT_HEADER_INDENT, 0));
		if (this.targets().length > 0) {
			this.addChild({
				render: (width) => this.targetLines(width),
				invalidate: () => {},
			});
		}
		this.addChild(new Text(
			theme.fg("muted", `... ${keyHint("app.tools.expand", "to expand")}`),
			TRANSCRIPT_BRANCH_INDENT,
			0,
		));
	}

	private expanded(): boolean {
		return this.group.items.some((item) => (item.kind === "tool" ? item.tool.expanded : item.bash.expanded));
	}

	private headerText(): string {
		const status = aggregateStatus(this.group.items);
		const color = status === "error" ? "error" : "accent";
		const action = status === "running" ? presentSummary(this.group.items) : pastSummary(this.group.items);
		const suffix = statusSuffix(status);
		return `${theme.fg(color, theme.bold(uiGlyphs().bullet))} ${theme.fg(color, theme.bold(`${action}${suffix}`))}`;
	}

	private targets(): Array<{ text: string; path: boolean }> {
		return this.group.items.flatMap((item) => {
			const text = item.kind === "tool" ? item.tool.args : item.bash.command;
			const sanitized = text ? sanitizeInline(text) : "";
			return sanitized
				? [{ text: sanitized, path: item.kind === "tool" && isReadToolName(item.tool.name) }]
				: [];
		});
	}

	private targetLines(width: number): string[] {
		const targets = this.targets();
		const available = Math.max(1, width - TRANSCRIPT_BRANCH_INDENT * 2);
		const prefix = `${uiGlyphs().output} `;
		const contentWidth = Math.max(1, available - visibleWidth(prefix));
		const previewCount = contentWidth >= 48 ? 3 : contentWidth >= 24 ? 2 : 1;
		const displayed = targets.slice(0, previewCount);
		const omitted = targets.length - displayed.length;
		const omittedSuffix = omitted > 0 ? `, ${uiGlyphs().ellipsis} +${omitted}` : "";
		const separatorWidth = Math.max(0, displayed.length - 1) * visibleWidth(", ");
		const targetsWidth = Math.max(1, contentWidth - visibleWidth(omittedSuffix) - separatorWidth);
		const targetWidth = Math.max(1, Math.floor(targetsWidth / Math.max(1, displayed.length)));
		const preview = displayed
			.map((target) => target.path
				? compactPathPreview(target.text, targetWidth) ?? "file"
				: truncateToWidth(target.text, targetWidth, uiGlyphs().ellipsis))
			.join(", ");
		const line = truncateToWidth(`${prefix}${preview}${omittedSuffix}`, available, theme.fg("dim", uiGlyphs().ellipsis));
		return [`${" ".repeat(TRANSCRIPT_BRANCH_INDENT)}${theme.fg("muted", line)}`];
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
			return ` ${uiGlyphs().separator} Running`;
		case "error":
			return ` ${uiGlyphs().separator} Failed`;
		case "cancelled":
			return ` ${uiGlyphs().separator} Cancelled`;
		case "success":
			return "";
	}
}

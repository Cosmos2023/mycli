import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../../tui-core/index.ts";
import type { MycliShellSessionTree, MycliShellSessionTreeNode } from "../../model.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { DynamicBorder } from "../shared/dynamic-border.ts";
import { keyHint } from "../shared/keybinding-hints.ts";

type TreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

const FILTERS: TreeFilter[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

export type SessionTreeSelectorOptions = {
	tui: TUI;
	tree: MycliShellSessionTree;
	onSelect: (node: MycliShellSessionTreeNode) => void;
	onCancel: () => void;
};

export class SessionTreeSelectorComponent extends Container {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly tui: TUI;
	private readonly tree: MycliShellSessionTree;
	private readonly collapsed = new Set<string>();
	private filter: TreeFilter = "default";
	private visibleNodes: MycliShellSessionTreeNode[] = [];
	private selectedIndex = 0;
	private readonly onSelectCallback: (node: MycliShellSessionTreeNode) => void;
	private readonly onCancelCallback: () => void;

	constructor(options: SessionTreeSelectorOptions) {
		super();
		this.tui = options.tui;
		this.tree = options.tree;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild({
			render: (width) => this.headerLines(width),
			invalidate: () => {},
		});
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.refresh();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.input.tab")) {
			this.filter = nextFilter(this.filter);
			this.refresh();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.up") || data === "k") {
			if (this.visibleNodes.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.visibleNodes.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			if (this.visibleNodes.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.visibleNodes.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 10);
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(Math.max(0, this.visibleNodes.length - 1), this.selectedIndex + 10);
			this.updateList();
			return;
		}
		if (data === "\x1b[D" || data === "h") {
			const selected = this.visibleNodes[this.selectedIndex];
			if (selected?.kind === "session") {
				this.collapsed.add(selected.id);
				this.refresh();
			}
			return;
		}
		if (data === "\x1b[C" || data === "l" || data === " ") {
			const selected = this.visibleNodes[this.selectedIndex];
			if (selected?.kind === "session") {
				if (this.collapsed.has(selected.id)) this.collapsed.delete(selected.id);
				else this.collapsed.add(selected.id);
				this.refresh();
			}
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.visibleNodes[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		this.searchInput.handleInput(data);
		this.refresh();
		this.tui.requestRender();
	}

	private headerLines(width: number): string[] {
		const title = theme.bold("Conversation Tree");
		const filter = `${theme.fg("muted", "Filter: ")}${theme.fg("accent", this.filter)}`;
		const count = `${theme.fg("muted", "Nodes: ")}${theme.fg("accent", `${this.visibleNodes.length}/${this.tree.nodes.length}`)}`;
		const right = `${filter}  ${count}`;
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(right));
		const first = truncateToWidth(`${title}${" ".repeat(gap)}${right}`, width, "");
		const second = truncateToWidth(
			[
				keyHint("tui.input.tab", "filter"),
				keyHint("tui.select.confirm", "select"),
				theme.fg("muted", "h/l fold"),
				theme.fg("muted", "type to search"),
			].join(theme.fg("muted", ` ${uiGlyphs().separator} `)),
			width,
			"...",
		);
		return [first, second];
	}

	private refresh(): void {
		this.visibleNodes = this.applyFilters();
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.visibleNodes.length - 1));
		this.updateList();
	}

	private applyFilters(): MycliShellSessionTreeNode[] {
		const query = this.searchInput.getValue().trim();
		const queryMatches = query
			? fuzzyFilter(this.tree.nodes, query, (node) => searchText(node))
			: this.tree.nodes;
		const queryIds = new Set(queryMatches.map((node) => node.id));
		return this.tree.nodes.filter((node) => {
			if (query && !queryIds.has(node.id)) return false;
			if (!this.matchesFilter(node)) return false;
			return this.isVisibleByCollapse(node);
		});
	}

	private matchesFilter(node: MycliShellSessionTreeNode): boolean {
		if (this.filter === "all") return true;
		if (this.filter === "labeled-only") return Boolean(node.label);
		if (node.kind === "session") return true;
		if (this.filter === "user-only") return node.role === "user";
		if (this.filter === "no-tools") return node.role !== "tool" && !node.toolName;
		return node.role !== "tool";
	}

	private isVisibleByCollapse(node: MycliShellSessionTreeNode): boolean {
		let parentId = node.parentId;
		while (parentId) {
			if (this.collapsed.has(parentId)) return false;
			parentId = this.tree.nodes.find((candidate) => candidate.id === parentId)?.parentId;
		}
		return true;
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.tree.nodes.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No conversation tree data available"), 0, 0));
			return;
		}
		if (this.visibleNodes.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching tree nodes"), 0, 0));
			return;
		}
		const maxVisible = 12;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.visibleNodes.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.visibleNodes.length);
		for (let index = startIndex; index < endIndex; index += 1) {
			const node = this.visibleNodes[index];
			if (!node) continue;
			this.listContainer.addChild(new Text(this.renderNodeLine(node, index === this.selectedIndex), 0, 0));
			if (index === this.selectedIndex && node.preview) {
				for (const line of this.previewLines(node).slice(0, 3)) {
					this.listContainer.addChild(new Text(theme.fg("dim", `     ${truncateToWidth(line, 88, "...")}`), 0, 0));
				}
			}
		}
		if (this.visibleNodes.length > maxVisible) {
			this.listContainer.addChild(new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.visibleNodes.length})`), 0, 0));
		}
	}

	private renderNodeLine(node: MycliShellSessionTreeNode, selected: boolean): string {
		const prefix = selected ? theme.fg("accent", `${uiGlyphs().arrow} `) : "  ";
		const indent = "  ".repeat(Math.max(0, node.depth));
		const connector = node.kind === "session"
			? (this.collapsed.has(node.id) ? uiGlyphs().collapsed : uiGlyphs().expanded)
			: uiGlyphs().bullet;
		const active = node.active
			? theme.fg("success", `${uiGlyphs().active} `)
			: node.onActivePath
				? theme.fg("accent", `${uiGlyphs().vertical} `)
				: "  ";
		const label = node.label ? ` [${node.label}]` : "";
		const count = node.messageCount === undefined ? "" : theme.fg("muted", ` ${node.messageCount} msg`);
		const role = node.kind === "message" ? theme.fg("muted", `${node.role}: `) : "";
		const summary = selected ? theme.fg("accent", node.summary) : node.summary;
		return truncateToWidth(`${prefix}${indent}${active}${connector} ${role}${summary}${label}${count}`, 100, "...");
	}

	private previewLines(node: MycliShellSessionTreeNode): string[] {
		const lines = (node.preview ?? "").split("\n").filter((line) => line.trim());
		const query = this.searchInput.getValue().trim().toLowerCase();
		if (!query) return lines;
		const tokens = query.split(/\s+/).filter(Boolean);
		const matchingLines = lines.filter((line) => {
			const normalized = line.toLowerCase();
			return tokens.every((token) => normalized.includes(token));
		});
		return matchingLines.length > 0 ? matchingLines : lines;
	}
}

function nextFilter(filter: TreeFilter): TreeFilter {
	const index = FILTERS.indexOf(filter);
	return FILTERS[(index + 1) % FILTERS.length] ?? "default";
}

function searchText(node: MycliShellSessionTreeNode): string {
	return [node.summary, node.role, node.label, node.toolName, node.preview, node.sessionId].filter(Boolean).join(" ");
}

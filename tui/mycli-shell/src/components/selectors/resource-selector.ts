import { Container, getKeybindings, Input, Spacer, Text, type TUI, truncateToWidth, visibleWidth } from "../../tui-core/index.ts";
import type { MycliShellResource } from "../../model.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { DynamicBorder } from "../shared/dynamic-border.ts";
import { keyHint } from "../shared/keybinding-hints.ts";

type ResourceFilter = "all" | MycliShellResource["type"];

export type ResourceSelectorOptions = {
	tui: TUI;
	resources: MycliShellResource[];
	onSelect: (resource: MycliShellResource) => void;
	onCancel: () => void;
};

const FILTERS: ResourceFilter[] = ["all", "mcp", "plugin", "skill", "hook", "prompt", "theme"];

export class ResourceSelectorComponent extends Container {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly resources: MycliShellResource[];
	private filteredResources: MycliShellResource[];
	private selectedIndex = 0;
	private filter: ResourceFilter = "all";

	constructor(private readonly options: ResourceSelectorOptions) {
		super();
		this.resources = [...options.resources];
		this.filteredResources = this.applyFilters("");
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild({ render: (width) => this.headerLines(width), invalidate: () => {} });
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateList();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.input.tab")) {
			this.cycleFilter();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredResources.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredResources.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredResources.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredResources.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.filteredResources[this.selectedIndex];
			if (selected) this.options.onSelect(selected);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		this.searchInput.handleInput(data);
		this.refresh();
	}

	private cycleFilter(): void {
		const index = FILTERS.indexOf(this.filter);
		this.filter = FILTERS[(index + 1) % FILTERS.length] ?? "all";
		this.refresh();
	}

	private refresh(): void {
		this.filteredResources = this.applyFilters(this.searchInput.getValue());
		this.selectedIndex = 0;
		this.updateList();
		this.options.tui.requestRender();
	}

	private applyFilters(query: string): MycliShellResource[] {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		return this.resources.filter((resource) => {
			if (this.filter !== "all" && resource.type !== this.filter) return false;
			const haystack = [resource.name, resource.type, resource.source, resource.status, resource.detail].filter(Boolean).join(" ").toLowerCase();
			return tokens.every((token) => haystack.includes(token));
		});
	}

	private headerLines(width: number): string[] {
		const title = theme.fg("selectorTitle", theme.bold("Resources"));
		const filter = `${theme.fg("selectorMeta", "Type: ")}${theme.fg("selectorMatch", this.filter)}`;
		const total = `${this.filteredResources.length}/${this.resources.length}`;
		const right = `${filter}  ${theme.fg("selectorMeta", total)}`;
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(right));
		return [
			truncateToWidth(`${title}${" ".repeat(gap)}${right}`, width, ""),
			truncateToWidth(`${keyHint("tui.input.tab", "type")} ${uiGlyphs().separator} type to search ${uiGlyphs().separator} Enter opens runtime inspect output`, width, "..."),
		];
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.resources.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("selectorMeta", "  No resources reported by runtime"), 0, 0));
			return;
		}
		if (this.filteredResources.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("selectorMeta", "  No matching resources"), 0, 0));
			return;
		}
		const maxVisible = 11;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredResources.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filteredResources.length);
		for (let index = startIndex; index < endIndex; index += 1) {
			const resource = this.filteredResources[index];
			if (!resource) continue;
			this.listContainer.addChild(new Text(this.resourceLine(resource, index === this.selectedIndex), 0, 0));
		}
		if (this.filteredResources.length > maxVisible) {
			this.listContainer.addChild(new Text(theme.fg("selectorMeta", `  (${this.selectedIndex + 1}/${this.filteredResources.length})`), 0, 0));
		}
		const selected = this.filteredResources[this.selectedIndex];
		if (selected?.detail) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("selectorMeta", `  ${selected.detail}`), 0, 0));
		}
	}

	private resourceLine(resource: MycliShellResource, selected: boolean): string {
		const prefix = selected ? theme.fg("selectorMatch", `${uiGlyphs().arrow} `) : "  ";
		const marker = (resource.type === "plugin" || resource.type === "mcp") && resource.status && !["enabled", "loaded", "disabled"].includes(resource.status)
			? resource.status.replaceAll("_", " ")
			: resource.enabled === false ? "off" : resource.enabled === true ? "on" : resource.status ?? "info";
		const labelColor = resourceTypeColor(resource.type);
		const label = selected ? theme.fg("selectorMatch", resource.name) : theme.fg(labelColor, resource.name);
		const statusColor = resourceStatusColor(resource);
		const source = resource.source ? theme.fg("selectorMeta", resource.source) : undefined;
		const meta = [theme.fg(labelColor, resource.type), source, theme.fg(statusColor, marker)].filter(Boolean).join(theme.fg("selectorMeta", ` ${uiGlyphs().separator} `));
		return `${prefix}${label} ${truncateToWidth(meta, 72, "...")}`;
	}
}

function resourceTypeColor(resourceType: MycliShellResource["type"]) {
	switch (resourceType) {
		case "hook":
			return "resourceHook";
		case "plugin":
			return "resourcePlugin";
		case "mcp":
			return "accent";
		case "skill":
			return "resourceSkill";
		case "prompt":
			return "resourcePrompt";
		case "theme":
			return "resourceTheme";
	}
}

function resourceStatusColor(resource: MycliShellResource) {
	if (resource.status === "issue") return "resourceIssue";
	if (resource.type === "plugin" || resource.type === "mcp") {
		if (["error", "failed", "cached", "partial", "migration_required"].includes(resource.status ?? "")) return "resourceIssue";
		if (resource.status === "loading") return "selectorMeta";
		if (resource.status === "closed") return "resourceDisabled";
	}
	if (resource.enabled === false || resource.status === "disabled") return "resourceDisabled";
	if (resource.enabled === true || resource.status === "enabled") return "resourceEnabled";
	return "selectorMeta";
}

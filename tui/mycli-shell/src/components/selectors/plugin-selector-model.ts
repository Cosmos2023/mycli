import type { PluginCatalog, PluginCatalogEntry, PluginChange, PluginMarketplaceEntry } from "@mycli/contracts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import type { DecisionItem } from "./decision-list.ts";

export const ALL_PLUGINS_TAB = "all";
export const INSTALLED_PLUGINS_TAB = "installed";
export const ADD_MARKETPLACE_TAB = "add";
export const marketplaceTab = (name: string): string => `marketplace:${name}`;
export const tabMarketplace = (tab: string): string | undefined => tab.startsWith("marketplace:") ? tab.slice(12) : undefined;

export interface PluginAction extends DecisionItem {
	readonly change?: PluginChange;
	readonly confirmation?: string;
}

export function filterPlugins(catalog: PluginCatalog | undefined, tab: string, query: string): PluginCatalogEntry[] {
	const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
	const market = tabMarketplace(tab);
	return (catalog?.plugins ?? []).filter((item) => (tab !== INSTALLED_PLUGINS_TAB || item.installed)
		&& (!market || item.marketplace === market)
		&& tokens.every((token) => `${item.id} ${item.name} ${item.description} ${item.source} ${item.marketplace ?? ""}`.toLowerCase().includes(token)));
}

export function pluginStatus(plugin: PluginCatalogEntry): string {
	if (plugin.status === "invalid") return "Invalid";
	if (plugin.status === "migration_required") return "Migration required";
	if (plugin.installed) return `${plugin.enabled ? "Enabled" : "Disabled"}${plugin.issues.length ? ` ${uiGlyphs().separator} Issues` : ""}`;
	return plugin.status === "available" ? "Available" : "Unavailable";
}

export function pluginActions(plugin: PluginCatalogEntry): PluginAction[] {
	const target = { target: plugin.id, revision: plugin.revision };
	const actions: PluginAction[] = [{ label: "Back to plugins" }];
	if (!plugin.installed) {
		if (plugin.status === "available") actions.push({ label: "Install plugin", change: { action: "install", ...target } });
		return actions;
	}
	if (plugin.status === "installed" || plugin.enabled) actions.push({ label: plugin.enabled ? "Disable plugin" : "Enable plugin",
		change: { action: plugin.enabled ? "disable" : "enable", ...target } });
	if (plugin.managed) actions.push({ label: "Update plugin", change: { action: "update", ...target } },
		{ label: "Uninstall plugin", change: { action: "remove", ...target }, confirmation: `Uninstall ${plugin.name}? Changes apply at the next safe refresh.` });
	return actions;
}

export function marketplaceActions(market: PluginMarketplaceEntry): PluginAction[] {
	const target = { target: market.name, revision: market.revision };
	return [{ label: "Back to plugins" }, { label: "Refresh marketplace", description: "Fetch the latest catalog", change: { action: "marketplace_upgrade", ...target } },
		{ label: "Remove marketplace", change: { action: "marketplace_remove", ...target }, confirmation: `Remove ${market.name}? Installed plugins will be retained.` }];
}

export function pluginDetails(plugin: PluginCatalogEntry): string[] {
	const details = [pluginStatus(plugin), plugin.description, `ID: ${plugin.id}`, `Source: ${plugin.source}`,
		...(plugin.marketplace ? [`Marketplace: ${plugin.marketplace}`] : []), ...(plugin.version ? [`Version: ${plugin.version}`] : [])];
	const cap = plugin.capabilities;
	details.push(cap ? `Skills: ${cap.skills} ${uiGlyphs().separator} MCP servers: ${cap.mcpServers} ${uiGlyphs().separator} Hook events: ${cap.hooks} ${uiGlyphs().separator} Tools: ${cap.tools} ${uiGlyphs().separator} Commands: ${cap.commands}`
		: "Capabilities are available after installation.");
	if (plugin.installed) details.push("Enabled/disabled reflects configuration. Running turns retain their current plugins until a safe refresh.");
	if (plugin.installed && !plugin.managed) details.push("Directory plugin: update or remove its source directory outside this manager.");
	details.push(...plugin.issues.map((issue) => `Issue: ${issue}`));
	return details.filter(Boolean);
}

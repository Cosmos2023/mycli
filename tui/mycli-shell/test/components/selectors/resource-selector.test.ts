import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ResourceSelectorComponent } from "../../../src/components/selectors/resource-selector.ts";
import { theme } from "../../../src/theme/theme.ts";
import { TUI, visibleWidth } from "../../../src/tui-core/index.ts";
import { HeadlessTerminal } from "../../support/headless-terminal.ts";
import { resourcesFromResult } from "../../../src/state/catalog-state.ts";

test("plugin resource health takes precedence over configured enablement", () => {
	const terminal = new HeadlessTerminal();
	const tui = new TUI(terminal);
	for (const [status, label, color] of [
		["enabled", "on", "resourceEnabled"],
		["loading", "loading", "selectorMeta"],
		["error", "error", "resourceIssue"],
		["closed", "closed", "resourceDisabled"],
		["disabled", "off", "resourceDisabled"],
		["migration_required", "migration required", "resourceIssue"],
	] as const) {
		const selector = new ResourceSelectorComponent({ tui,
			resources: [{ id: "plugin:demo", type: "plugin", name: "demo", source: "repo", enabled: status !== "disabled", status }],
			onSelect: () => undefined, onCancel: () => undefined,
		});
		const row = selector.render(80).find((line) => stripVTControlCharacters(line).includes("demo"));
		assert.ok(row);
		assert.ok(row.includes(theme.fg(color, label)));
		assert.ok(stripVTControlCharacters(row).trimEnd().endsWith(label));
		for (const width of [24, 48, 80, 160]) {
			assert.ok(selector.render(width).every((line) => visibleWidth(line) <= width));
		}
	}
});

test("MCP resources retain their type and connection state in the selector", () => {
	const terminal = new HeadlessTerminal();
	const tui = new TUI(terminal);
	for (const status of ["loading", "failed", "cached", "ready", "disabled"]) {
		const resources = resourcesFromResult({ resources: [{
			id: "mcp:docs", type: "mcp", name: "docs", source: "runtime",
			enabled: status !== "disabled", status, command: "/mcp",
		}] });
		assert.equal(resources[0]?.type, "mcp");
		const selector = new ResourceSelectorComponent({ tui, resources, onSelect: () => undefined, onCancel: () => undefined });
		const row = selector.render(80).map(stripVTControlCharacters).find((line) => line.includes("docs"));
		assert.ok(row?.includes("mcp"));
		assert.ok(row?.trimEnd().endsWith(status === "disabled" ? "off" : status));
		for (const width of [24, 48, 80, 160]) {
			assert.ok(selector.render(width).every((line) => visibleWidth(line) <= width));
		}
	}
});

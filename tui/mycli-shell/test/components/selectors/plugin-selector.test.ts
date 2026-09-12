import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { PluginCatalog, PluginCatalogEntry, PluginChange, PluginOperation } from "@mycli/contracts";
import { PluginSelectorComponent } from "../../../src/components/selectors/plugin-selector.ts";
import { theme } from "../../../src/theme/theme.ts";
import { visibleWidth } from "../../../src/tui-core/index.ts";

const revision = "a".repeat(64);
function plugin(id: string, installed = false): PluginCatalogEntry {
	return { id, revision, name: id, description: "Search documentation and 中文文件", source: "Local package", marketplace: "personal",
		installed, enabled: installed, managed: installed, status: installed ? "installed" : "available", issues: [] };
}
function catalog(): PluginCatalog {
	return { plugins: [plugin("alpha@personal", true), plugin("bravo@personal"), plugin("charlie@personal")],
		marketplaces: [{ name: "personal", revision, source: "Local directory", issues: [] }], issues: [], truncated: false, repository_enabled: true };
}
function result(): PluginOperation { return { operation_id: "operation", state: "completed", message: "Plugin updated.", issues: [] }; }
function output(selector: PluginSelectorComponent, width = 100): string { return stripAnsi(selector.render(width).join("\n")); }

test("plugin search, detail and toggle retain the selected item and only run explicit actions", async () => {
	const data = catalog();
	const changes: PluginChange[] = [];
	const selector = new PluginSelectorComponent({ manager: { load: async () => data, change: async (change) => {
		changes.push(change); data.plugins[0]!.enabled = false; return result();
	} }, maxHeight: () => 24, onCancel() {} });
	await setImmediate();
	assert.match(output(selector), /All Plugins/);
	selector.handleInput(" "); await setImmediate();
	assert.equal(changes[0]?.action, "disable");
	assert.match(output(selector), /Disabled/);
	selector.handleInput("bravo"); selector.handleInput("\r");
	assert.match(output(selector), /Install plugin/);
	assert.equal(changes.length, 1);
	selector.handleInput("\x1b");
	assert.match(output(selector), /bravo/);
	assert.doesNotMatch(output(selector), /alpha@personal/);
	selector.handleInput("\r"); selector.handleInput("\x1b[B"); selector.handleInput("\r"); await setImmediate();
	assert.equal(changes[1]?.action, "install");
	selector.dispose();
});

test("removal requires explicit confirmation and inspection cannot trigger a hidden action", async () => {
	const changes: PluginChange[] = [];
	const selector = new PluginSelectorComponent({ manager: { load: async () => catalog(), change: async (change) => { changes.push(change); return result(); } }, onCancel() {}, maxHeight: () => 18 });
	await setImmediate(); selector.handleInput("\r");
	for (let index = 0; index < 3; index++) selector.handleInput("\x1b[B");
	selector.handleInput("\r");
	assert.match(output(selector), /Uninstall alpha/);
	selector.handleInput("\r"); assert.equal(changes.length, 0); // Default is Cancel.
	for (let index = 0; index < 3; index++) selector.handleInput("\x1b[B");
	selector.handleInput("\r"); selector.handleInput("\x1b[B");
	selector.handleInput("\x01"); selector.handleInput("\r"); assert.equal(changes.length, 0);
	selector.handleInput("\x1b"); selector.handleInput("\r"); await setImmediate();
	assert.equal(changes[0]?.action, "remove"); selector.dispose();
});

test("marketplace navigation and source review use separate actions with stable source text", async () => {
	const markets: (string | undefined)[] = [];
	const changes: PluginChange[] = [];
	const selector = new PluginSelectorComponent({ manager: { load: async (_signal, marketplace) => { markets.push(marketplace); return catalog(); },
		change: async (change) => { changes.push(change); return result(); } }, onCancel() {} });
	await setImmediate();
	selector.handleInput("\x1b[C"); await setImmediate();
	assert.match(output(selector), /1 plugins/);
	selector.handleInput("\x1b[C"); await setImmediate();
	assert.equal(markets.at(-1), "personal");
	selector.handleInput("\r"); assert.match(output(selector), /Refresh marketplace/);
	selector.handleInput("\x1b[B"); selector.handleInput("\r"); await setImmediate();
	assert.equal(changes[0]?.action, "marketplace_upgrade");
	selector.handleInput("\x1b"); selector.handleInput("\x1b[C");
	selector.handleInput("/tmp/中文 market"); selector.handleInput("\r");
	assert.match(output(selector), /Source: \/tmp\/中文 market/); assert.equal(changes.length, 1);
	selector.handleInput("\x1b[B"); selector.handleInput("\r"); await setImmediate();
	assert.deepEqual(changes[1], { action: "marketplace_add", source: "/tmp/中文 market" }); selector.dispose();
});

test("closing aborts loading or mutations and late responses cannot reopen the selector", async () => {
	const pending = Promise.withResolvers<PluginCatalog>();
	let abort: AbortSignal | undefined;
	let cancelled = 0;
	let renders = 0;
	const selector = new PluginSelectorComponent({ onRender: () => renders++, onCancel: () => cancelled++,
		manager: { load: async (signal) => { abort = signal; return pending.promise; }, change: async () => result() } });
	assert.match(output(selector), /Loading plugins/);
	selector.handleInput("\x1b"); assert.equal(abort?.aborted, true); assert.equal(cancelled, 1);
	const renderCount = renders; pending.resolve(catalog()); await setImmediate(); assert.equal(renders, renderCount);
	const mutation = Promise.withResolvers<PluginOperation>();
	const second = new PluginSelectorComponent({ onRender: () => renders++, onCancel: () => cancelled++,
		manager: { load: async () => catalog(), change: async (_change, signal) => { abort = signal; return mutation.promise; } } });
	await setImmediate(); second.handleInput(" "); second.handleInput("\x1b");
	assert.equal(abort?.aborted, true); const count = renders; mutation.resolve(result()); await setImmediate(); assert.equal(renders, count);
});

test("catalog failures recover and large Unicode lists remain bounded at narrow sizes and without colors", async () => {
	let fail = true;
	let height = 12;
	const data = catalog();
	data.plugins = Array.from({ length: 60 }, (_, index) => ({ ...plugin(`plugin-${index}@personal`), name: `${index} 中文插件`.repeat(5) }));
	const selector = new PluginSelectorComponent({ manager: { load: async () => { if (fail) throw new Error("private details"); return data; }, change: async () => result() }, onCancel() {}, maxHeight: () => height });
	await setImmediate(); assert.match(output(selector), /Could not load plugins/); assert.doesNotMatch(output(selector), /private details/);
	fail = false; selector.handleInput("\x12"); await setImmediate(); assert.doesNotMatch(output(selector), /Could not load/);
	try {
		theme.setColorMode("none");
		for (const width of [20, 32, 60, 80, 140]) for (height of [7, 12, 24]) {
			selector.handleInput("\x1b[6~");
			const lines = selector.render(width);
			assert.ok(lines.length <= height);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${height}`);
			assert.doesNotMatch(lines.join("\n"), /\x1b\[(?:3[0-9]|4[0-9]|9[0-9]|10[0-7])(?:;|m)/u);
		}
	} finally { theme.setColorMode("truecolor"); selector.dispose(); }
});

test("plugin details load on demand, block unverified actions and ignore a late response after returning", async () => {
	const pending = Promise.withResolvers<{ plugin: PluginCatalogEntry; details: string[] }>();
	let calls = 0;
	let signal: AbortSignal | undefined;
	const data = catalog();
	const selector = new PluginSelectorComponent({ manager: { load: async () => data, change: async () => { calls++; return result(); },
		inspect: async (_plugin, abort) => { signal = abort; return pending.promise; } }, onCancel() {}, maxHeight: () => 20 });
	await setImmediate(); selector.handleInput("\r");
	assert.match(output(selector), /Loading plugin details/);
	assert.doesNotMatch(output(selector), /Disable plugin/);
	selector.handleInput("\x1b[B"); selector.handleInput("\r"); assert.equal(calls, 0);
	assert.match(output(selector), /All Plugins/);
	selector.handleInput("\r"); selector.handleInput("\x1b"); assert.equal(signal?.aborted, true);
	pending.resolve({ plugin: data.plugins[0]!, details: ["Late capability"] }); await setImmediate();
	assert.doesNotMatch(output(selector), /Late capability/);
	selector.handleInput("\r"); await setImmediate(); assert.match(output(selector), /Disable plugin/);
	selector.handleInput("\x01"); selector.render(100); selector.handleInput("\x1b[F");
	assert.match(output(selector), /Late capability/); selector.dispose();
});

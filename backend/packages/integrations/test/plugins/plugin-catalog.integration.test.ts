import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseGatewayResult } from "@mycli/contracts";
import { PluginCatalogService } from "../../src/plugins/catalog.ts";
import { PluginPackageManager } from "../../src/plugins/package-management.ts";
import { stagePluginSource } from "../../src/plugins/package-source.ts";
import { readPluginPackageRegistry } from "../../src/plugins/package-registry.ts";

const signal = (): AbortSignal => new AbortController().signal;
async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-catalog-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const options = { homeDir: join(root, "home"), workspaceRoot: join(root, "workspace"), includeRepository: true };
	const source = join(root, "market");
	await mkdir(options.workspaceRoot, { recursive: true });
	await mkdir(join(source, ".agents/plugins"), { recursive: true });
	await bundle(join(source, "review"));
	await writeFile(join(source, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "personal", plugins: [
		{ name: "review", source: "./review", description: "Review documentation" },
		{ name: "remote", source: { source: "url", url: "https://example.invalid/plugin.git" }, policy: { installation: "NOT_AVAILABLE" } },
	] }));
	const manager = new PluginPackageManager(options);
	assert.equal((await manager.execute({ action: "marketplace", operation: "add", target: source }, signal())).ok, true);
	return { root, source, options, manager, catalog: new PluginCatalogService(options) };
}
async function bundle(root: string): Promise<void> {
	await mkdir(join(root, ".codex-plugin"), { recursive: true });
	await mkdir(join(root, "skills/review"), { recursive: true });
	await writeFile(join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: "review", version: "1.0", description: "Review code",
		interface: { displayName: "Review 中文" }, mcpServers: { mcpServers: { never: { command: "never-start-this" } } },
		hooks: { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "never-run-this" }] }] } }, apps: {} }));
	await writeFile(join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review\n---\nReview changes.");
}

test("metadata catalog browses local capabilities, installs and toggles without executing components", async (t) => {
	const { catalog } = await fixture(t);
	const before = parseGatewayResult("plugin.catalog", await catalog.list(signal()));
	const available = before.plugins.find((item) => item.id === "review@personal")!;
	assert.equal(available.name, "Review 中文");
	assert.equal(available.description, "Review documentation");
	assert.equal(available.installed, false);
	assert.deepEqual(available.capabilities, { skills: 1, mcpServers: 1, hooks: 1, tools: 0, commands: 0 });
	assert.deepEqual(available.issues, ["plugin_apps_unavailable"]);
	const detail = parseGatewayResult("plugin.inspect", await catalog.inspect(available.id, available.revision, signal()));
	assert.ok(detail.details.includes("  review"));
	assert.ok(detail.details.includes("  never"));
	assert.ok(detail.details.includes("  SessionStart"));
	assert.doesNotMatch(JSON.stringify(detail), /never-start-this|never-run-this/);
	assert.equal(before.plugins.find((item) => item.id === "remote@personal")?.status, "unavailable");
	assert.equal((await catalog.change({ action: "install", target: available.id, revision: available.revision }, signal())).ok, true);
	const installed = (await catalog.list(signal())).plugins.find((item) => item.id === available.id)!;
	assert.equal(installed.enabled, true);
	assert.equal(installed.managed, true);
	assert.equal((await catalog.list(signal(), "personal")).plugins.find((item) => item.id === available.id)?.revision, installed.revision);
	assert.equal((await catalog.change({ action: "disable", target: installed.id, revision: installed.revision }, signal())).ok, true);
	assert.equal((await catalog.list(signal())).plugins.find((item) => item.id === available.id)?.enabled, false);
	assert.deepEqual((await catalog.change({ action: "remove", target: installed.id, revision: installed.revision }, signal())).issues, ["plugin_catalog_changed"]);
});

test("catalog isolates malformed marketplaces and honors repository trust", async (t) => {
	const { catalog, options } = await fixture(t);
	await bundle(join(options.workspaceRoot, ".mycli/plugins/review"));
	assert.ok((await catalog.list(signal())).plugins.some((item) => item.id === "review"));
	assert.equal((await new PluginCatalogService({ ...options, includeRepository: false }).list(signal())).plugins.some((item) => item.id === "review"), false);
	const registry = await readPluginPackageRegistry(options.homeDir);
	const manifest = join(options.homeDir, ".mycli/plugin-cache", registry.marketplaces[0]!.cacheKey, ".agents/plugins/marketplace.json");
	await writeFile(manifest, "{ invalid secret }");
	const response = await catalog.list(signal());
	assert.deepEqual(response.marketplaces[0]?.issues, ["plugin_json_invalid"]);
	assert.ok(response.plugins.some((item) => item.id === "review"));
	assert.doesNotMatch(JSON.stringify(response), /invalid secret/);
});

test("marketplace replacement rejects stale selection before staging and during commit", async (t) => {
	const { catalog, manager, options } = await fixture(t);
	const selected = (await catalog.list(signal())).plugins.find((item) => item.id === "review@personal")!;
	await manager.execute({ action: "marketplace", operation: "upgrade", target: "personal" }, signal());
	assert.deepEqual((await catalog.change({ action: "install", target: selected.id, revision: selected.revision }, signal())).issues, ["plugin_catalog_changed"]);
	const copied = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const controlled = new PluginCatalogService({ ...options, stageSource: async (source, destination, abort) => {
		await stagePluginSource(source, destination, abort); copied.resolve(); await release.promise;
	} });
	const current = (await controlled.list(signal())).plugins.find((item) => item.id === selected.id)!;
	const pending = controlled.change({ action: "install", target: current.id, revision: current.revision }, signal());
	await copied.promise;
	try { await manager.execute({ action: "marketplace", operation: "upgrade", target: "personal" }, signal()); }
	finally { release.resolve(); }
	assert.deepEqual((await pending).issues, ["plugin_install_conflict"]);
	assert.equal((await readPluginPackageRegistry(options.homeDir)).plugins.length, 0);
});

test("removing a marketplace retains installed packages and aborted changes do not alter configuration", async (t) => {
	const { catalog, options } = await fixture(t);
	let before = await catalog.list(signal());
	const selected = before.plugins.find((item) => item.id === "review@personal")!;
	await catalog.change({ action: "install", target: selected.id, revision: selected.revision }, signal());
	before = await catalog.list(signal());
	const market = before.marketplaces[0]!;
	assert.equal((await catalog.change({ action: "marketplace_remove", target: market.name, revision: market.revision }, signal())).ok, true);
	assert.equal((await readPluginPackageRegistry(options.homeDir)).plugins.length, 1);
	const installed = (await catalog.list(signal())).plugins[0]!;
	const controller = new AbortController(); controller.abort();
	const registryBefore = await readFile(join(options.homeDir, ".mycli/plugin-registry.json"), "utf8");
	await assert.rejects(catalog.change({ action: "remove", target: installed.id, revision: installed.revision }, controller.signal), { name: "AbortError" });
	assert.equal(await readFile(join(options.homeDir, ".mycli/plugin-registry.json"), "utf8"), registryBefore);
});

test("large combined catalogs report omissions while a named marketplace remains fully browsable", async (t) => {
	const { root, manager, catalog } = await fixture(t);
	for (let index = 0; index < 3; index++) {
		const source = join(root, `large-${index}`); await mkdir(join(source, ".agents/plugins"), { recursive: true });
		await writeFile(join(source, ".agents/plugins/marketplace.json"), JSON.stringify({ name: `large-${index}`,
			plugins: Array.from({ length: 1024 }, (_, entry) => ({ name: `plugin-${entry}`, source: { source: "url", url: "https://example.invalid/plugin.git" } })) }));
		assert.equal((await manager.execute({ action: "marketplace", operation: "add", target: source }, signal())).ok, true);
	}
	const all = parseGatewayResult("plugin.catalog", await catalog.list(signal()));
	assert.equal(all.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(all)) <= 6 * 1024 * 1024);
	const narrowed = await catalog.list(signal(), "large-2");
	assert.equal(narrowed.truncated, false);
	assert.equal(narrowed.plugins.length, 1024);
	assert.ok(narrowed.plugins.every((item) => item.marketplace === "large-2"));
});

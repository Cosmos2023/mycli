import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { discoverPlugins, PluginPackageManager } from "../../src/index.ts";
import { loadPluginBundle } from "../../src/plugins/bundle-manifest.ts";
import { copyPluginPackage } from "../../src/plugins/package-files.ts";
import { readPluginPackageRegistry, pluginCacheRoot } from "../../src/plugins/package-registry.ts";
import { resolvePackageSource, stagePluginSource } from "../../src/plugins/package-source.ts";
import { runPackageGit } from "../../src/plugins/package-git.ts";

const signal = new AbortController().signal;

test("missing bundle name uses the source name instead of the internal cache directory", async (t) => {
	const f = await fixture(t);
	await bundle(f.packageRoot, { description: "Name from folder" });
	assert.equal((await f.manager.execute({ action: "add", source: f.packageRoot }, signal)).plugins?.[0]?.pluginId, "demo");
	assert.equal((await discoverPlugins(f)).get("demo")?.kind, "bundle");
});

test("local marketplace install, disable, upgrade, update and remove preserve captured snapshots", async (t) => {
	const f = await fixture(t);
	await bundle(f.packageRoot, { name: "demo", version: "1" });
	await json(join(f.marketRoot, ".agents/plugins/marketplace.json"), { name: "personal", plugins: [{ name: "demo", source: "./plugins/demo" }] });
	assert.equal((await f.manager.execute({ action: "marketplace", operation: "add", target: f.marketRoot }, signal)).ok, true);
	assert.equal((await f.manager.execute({ action: "available" }, signal)).plugins?.[0]?.status, "available");
	assert.equal((await f.manager.execute({ action: "add", source: "demo@personal" }, signal)).ok, true);
	const first = (await readPluginPackageRegistry(f.homeDir)).plugins[0]!;
	const captured = pluginCacheRoot(f.homeDir, first.cacheKey);
	assert.equal((await discoverPlugins(f)).get("demo@personal")?.enabled, true);
	assert.equal((await f.manager.execute({ action: "disable", pluginId: "demo@personal" }, signal)).ok, true);
	assert.equal((await discoverPlugins(f)).get("demo@personal")?.enabled, false);
	assert.equal((await f.manager.execute({ action: "available" }, signal)).plugins?.[0]?.enabled, false);
	await bundle(f.packageRoot, { name: "demo", version: "2" });
	assert.equal((await f.manager.execute({ action: "marketplace", operation: "upgrade", target: "personal" }, signal)).ok, true);
	assert.equal((await f.manager.execute({ action: "update", pluginId: "demo@personal" }, signal)).ok, true);
	const updated = (await readPluginPackageRegistry(f.homeDir)).plugins[0]!;
	assert.equal(updated.version, "2");
	assert.notEqual(updated.cacheKey, first.cacheKey);
	assert.equal((await loadPluginBundle(captured)).version, "1");
	assert.equal((await discoverPlugins(f)).get("demo@personal")?.enabled, false);
	assert.equal((await f.manager.execute({ action: "enable", pluginId: "demo@personal" }, signal)).ok, true);
	assert.equal((await discoverPlugins(f)).get("demo@personal")?.enabled, true);
	assert.equal((await f.manager.execute({ action: "marketplace", operation: "remove", target: "personal" }, signal)).ok, true);
	assert.ok((await discoverPlugins(f)).get("demo@personal"));
	assert.equal((await f.manager.execute({ action: "remove", pluginId: "demo@personal" }, signal)).ok, true);
	assert.equal((await discoverPlugins(f)).get("demo@personal"), undefined);
	assert.equal((await loadPluginBundle(captured)).version, "1");
});

test("failed local updates leave the registry and previous package intact", async (t) => {
	const f = await fixture(t);
	await bundle(f.packageRoot, { name: "demo", version: "1" });
	assert.equal((await f.manager.execute({ action: "add", source: f.packageRoot }, signal)).ok, true);
	const before = await readPluginPackageRegistry(f.homeDir);
	await bundle(f.packageRoot, { name: "demo", skills: "./missing" });
	const failed = await f.manager.execute({ action: "update", pluginId: "demo" }, signal);
	assert.equal(failed.ok, false);
	assert.deepEqual(failed.issues, ["plugin_component_missing"]);
	assert.deepEqual(await readPluginPackageRegistry(f.homeDir), before);
	assert.equal((await readdir(join(f.homeDir, ".mycli/plugin-cache"))).length, 1);
	assert.doesNotMatch(JSON.stringify(failed), new RegExp(f.root));
});

test("concurrent installs commit one copy and clean the losing stage", async (t) => {
	const f = await fixture(t);
	await bundle(f.packageRoot, { name: "demo" });
	const results = await Promise.all([1, 2].map(() => f.manager.execute({ action: "add", source: f.packageRoot }, signal)));
	assert.equal(results.filter((item) => item.ok).length, 1);
	assert.deepEqual(results.find((item) => !item.ok)?.issues, ["plugin_install_conflict"]);
	assert.equal((await readPluginPackageRegistry(f.homeDir)).plugins.length, 1);
	assert.equal((await readdir(join(f.homeDir, ".mycli/plugin-cache"))).length, 1);
});

test("cancellation after staging does not commit or retain an incomplete package", async (t) => {
	const f = await fixture(t);
	await bundle(f.packageRoot, { name: "demo" });
	const abort = new AbortController();
	const manager = new PluginPackageManager({ ...f, stageSource: async (source, target, activeSignal) => {
		await stagePluginSource(source, target, activeSignal);
		abort.abort();
	} });
	await assert.rejects(manager.execute({ action: "add", source: f.packageRoot }, abort.signal), { name: "AbortError" });
	assert.deepEqual((await readPluginPackageRegistry(f.homeDir)).plugins, []);
	assert.deepEqual(await readdir(join(f.homeDir, ".mycli/plugin-cache")), []);
});

test("bundle defaults and Claude manifest fallback load without executing hooks or scripts", async (t) => {
	const f = await fixture(t);
	await json(join(f.packageRoot, ".claude-plugin/plugin.json"), { name: "demo" });
	await json(join(f.packageRoot, ".mcp.json"), { mcpServers: { local: { command: "never-execute" } } });
	await json(join(f.packageRoot, "hooks/hooks.json"), { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "exit 99" }] }] } });
	await json(join(f.packageRoot, ".app.json"), { apps: [] });
	await write(join(f.packageRoot, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review changes\n---\nReview carefully.");
	const result = await f.manager.execute({ action: "add", source: f.packageRoot }, signal);
	assert.equal(result.ok, true);
	assert.deepEqual(result.issues, ["plugin_apps_unavailable"]);
	const discovered = (await discoverPlugins(f)).get("demo");
	assert.equal(discovered?.kind, "bundle");
	if (discovered?.kind !== "bundle") assert.fail("bundle missing");
	assert.equal(discovered.manifest.skillFiles.length, 1);
	assert.equal(discovered.manifest.mcp.length, 1);
	assert.equal(discovered.manifest.hooks.length, 1);
});

test("package paths reject escapes, symlink cycles and copying into the source", async (t) => {
	const f = await fixture(t);
	await bundle(f.packageRoot, { name: "demo", skills: "./../outside" });
	await assert.rejects(loadPluginBundle(f.packageRoot), /plugin_path_invalid/u);
	await bundle(f.packageRoot, { name: "demo" });
	const outside = join(f.root, "outside");
	if (process.platform === "win32") await mkdir(outside);
	await write(process.platform === "win32" ? join(outside, "secret") : outside, "private-value");
	await symlink(outside, join(f.packageRoot, "escape"), process.platform === "win32" ? "junction" : "file");
	const result = await f.manager.execute({ action: "add", source: f.packageRoot }, signal);
	assert.deepEqual(result.issues, ["plugin_path_escape"]);
	await rm(join(f.packageRoot, "escape"));
	await symlink(f.packageRoot, join(f.packageRoot, "cycle"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(copyPluginPackage(f.packageRoot, join(f.root, "copy"), signal), /plugin_path_cycle/u);
	await assert.rejects(copyPluginPackage(f.packageRoot, join(f.packageRoot, "nested"), signal), /plugin_destination_inside_source/u);
});

test("managed ESM packages remain discoverable and are never imported at installation", async (t) => {
	const f = await fixture(t);
	await cp(new URL("../fixtures/plugins/good/", import.meta.url), f.packageRoot, { recursive: true });
	const result = await f.manager.execute({ action: "add", source: f.packageRoot }, signal);
	assert.equal(result.ok, true);
	assert.equal((await discoverPlugins(f)).selected[0]?.kind, "plugin");
});

test("enablement keeps legacy user configuration and rejects unknown plugins", async (t) => {
	const f = await fixture(t);
	await bundle(f.packageRoot, { name: "demo" });
	await f.manager.execute({ action: "add", source: f.packageRoot }, signal);
	await write(join(f.homeDir, ".config/mycli/config.toml"), '[model]\nname = "preserved-model"\n[plugins]\nenabled = ["another"]\n');
	assert.equal((await f.manager.execute({ action: "disable", pluginId: "demo" }, signal)).ok, true);
	const config = await readFile(join(f.homeDir, ".mycli/config.toml"), "utf8");
	assert.match(config, /preserved-model/u);
	assert.match(config, /another/u);
	assert.deepEqual((await f.manager.execute({ action: "enable", pluginId: "absent" }, signal)).issues, ["plugin_not_found"]);
});

test("Git selectors are structured, and installed Git commands ignore user hooks and config", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await resolvePackageSource("owner/repo#stable", f.workspaceRoot, f.homeDir), { kind: "git", url: "https://github.com/owner/repo.git", ref: "stable" });
	for (const source of ["https://user:secret@example.com/repo", "file:///tmp/repo", "ext::bad", "https://example.com/repo#--upload-pack=bad"]) {
		await assert.rejects(resolvePackageSource(source, f.workspaceRoot, f.homeDir), /plugin_/u);
	}
	const control = join(f.root, "git-control");
	await mkdir(control);
	assert.equal(await runPackageGit(["config", "--get", "core.hooksPath"], control, signal), control);
	assert.equal(await runPackageGit(["config", "--get", "protocol.file.allow"], control, signal).catch(() => "unset"), "unset");
	assert.equal(await runPackageGit(["config", "--get", "protocol.allow"], control, signal), "never");
});

async function fixture(t: TestContext): Promise<{ readonly root: string; readonly workspaceRoot: string; readonly homeDir: string;
	readonly marketRoot: string; readonly packageRoot: string; readonly manager: PluginPackageManager }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-package-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const marketRoot = join(root, "marketplace");
	const packageRoot = join(marketRoot, "plugins/demo");
	await mkdir(workspaceRoot);
	await mkdir(homeDir);
	return { root, workspaceRoot, homeDir, marketRoot, packageRoot, manager: new PluginPackageManager({ workspaceRoot, homeDir }) };
}

async function bundle(root: string, manifest: Readonly<Record<string, unknown>>): Promise<void> {
	await json(join(root, ".codex-plugin/plugin.json"), manifest);
}

async function json(path: string, value: unknown): Promise<void> { await write(path, JSON.stringify(value)); }

async function write(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content, "utf8");
}

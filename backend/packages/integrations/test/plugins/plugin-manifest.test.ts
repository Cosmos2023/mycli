import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadPluginManifest } from "../../src/index.ts";

test("loads a validated Plugin API v2 manifest without importing its compiled entry", async (t) => {
	const fixture = await manifestFixture(t);
	const marker = join(fixture.root, "imported.txt");
	await writePlugin(fixture.pluginRoot, [
		"api_version: 2",
		"id: demo",
		"name: Demo",
		"version: 1.0.0",
		"entry: dist/index.js",
		"provides:",
		"  tools: [echo]",
		"  hooks: [pre_tool_use]",
		"  commands: [status]",
		"requires_env: [DEMO_TOKEN]",
		"capabilities: [filesystem_read]",
	], `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(marker)}, "ran"));`);

	const result = await loadPluginManifest({
		pluginRoot: fixture.pluginRoot,
		source: "repo",
		expectedPluginId: "demo",
	});

	assert.equal(result.kind, "loaded");
	if (result.kind !== "loaded") return;
	assert.equal(result.manifest.id, "demo");
	assert.equal(result.manifest.source, "repo");
	assert.equal(result.manifest.entryPath, await realpath(join(fixture.pluginRoot, "dist", "index.js")));
	assert.equal(Object.isFrozen(result.manifest), true);
	await assert.rejects(() => import("node:fs/promises").then(({ access }) => access(marker)));
});

test("rejects missing, escaping, symlinked, and identity-mismatched entries", async (t) => {
	const fixture = await manifestFixture(t);
	const outsideDirectory = join(fixture.root, "outside");
	await mkdir(outsideDirectory);
	const outside = join(outsideDirectory, "index.js");
	await writeFile(outside, "export {};", "utf8");
	const cases = [
		{ id: "demo", entry: "dist/missing.js", expected: "entry_missing" },
		{ id: "demo", entry: "../outside.js", expected: "invalid_manifest" },
		{ id: "other", entry: "dist/index.js", expected: "plugin_id_mismatch" },
	] as const;

	for (const [index, item] of cases.entries()) {
		const pluginRoot = join(fixture.root, `case-${index}`, "demo");
		await writePlugin(pluginRoot, manifestLines(item.id, item.entry), "export {};");
		if (item.entry.includes("missing")) {
			await rm(join(pluginRoot, "dist", "index.js"), { force: true });
		}
		const result = await loadPluginManifest({
			pluginRoot,
			source: "repo",
			expectedPluginId: "demo",
		});
		assert.equal(result.kind, "invalid");
		if (result.kind === "invalid") assert.equal(result.diagnostic.errorClass, item.expected);
	}

	const symlinkRoot = join(fixture.root, "symlink", "demo");
	await writePlugin(symlinkRoot, manifestLines("demo", "dist/index.js"), "export {};");
	if (process.platform === "win32") {
		await rm(join(symlinkRoot, "dist"), { recursive: true });
		await symlink(outsideDirectory, join(symlinkRoot, "dist"), "junction");
	} else {
		await rm(join(symlinkRoot, "dist", "index.js"));
		await symlink(outside, join(symlinkRoot, "dist", "index.js"));
	}
	const escaped = await loadPluginManifest({
		pluginRoot: symlinkRoot,
		source: "repo",
		expectedPluginId: "demo",
	});
	assert.equal(escaped.kind, "invalid");
	if (escaped.kind === "invalid") assert.equal(escaped.diagnostic.errorClass, "entry_path_escape");
});

test("returns bounded diagnostics without manifest content or private paths", async (t) => {
	const fixture = await manifestFixture(t);
	await mkdir(fixture.pluginRoot, { recursive: true });
	await writeFile(
		join(fixture.pluginRoot, "plugin.yaml"),
		"api_version: [token=private-value\nentry: /Users/private/plugin.js",
		"utf8",
	);

	const result = await loadPluginManifest({
		pluginRoot: fixture.pluginRoot,
		source: "repo",
		expectedPluginId: "demo",
	});

	assert.equal(result.kind, "invalid");
	const serialized = JSON.stringify(result);
	assert.equal(serialized.includes("private-value"), false);
	assert.equal(serialized.includes("/Users/private"), false);
	assert.equal(serialized.includes(fixture.root), false);
	if (result.kind === "invalid") {
		assert.deepEqual(Object.keys(result.diagnostic).sort(), [
			"errorClass",
			"fileLabel",
			"pluginId",
			"source",
		]);
	}
});

test("rejects invalid UTF-8 before YAML parsing", async (t) => {
	const fixture = await manifestFixture(t);
	await mkdir(fixture.pluginRoot, { recursive: true });
	await writeFile(
		join(fixture.pluginRoot, "plugin.yaml"),
		Buffer.from([0x61, 0x70, 0x69, 0x5f, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x3a, 0x20, 0xff]),
	);

	const result = await loadPluginManifest({
		pluginRoot: fixture.pluginRoot,
		source: "repo",
		expectedPluginId: "demo",
	});

	assert.equal(result.kind, "invalid");
	if (result.kind === "invalid") assert.equal(result.diagnostic.errorClass, "invalid_utf8");
});

async function manifestFixture(t: TestContext): Promise<{
	readonly root: string;
	readonly pluginRoot: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-manifest-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, pluginRoot: join(root, "demo") };
}

async function writePlugin(
	pluginRoot: string,
	manifest: readonly string[],
	entry: string,
): Promise<void> {
	await mkdir(join(pluginRoot, "dist"), { recursive: true });
	await writeFile(join(pluginRoot, "plugin.yaml"), `${manifest.join("\n")}\n`, "utf8");
	await writeFile(join(pluginRoot, "dist", "index.js"), entry, "utf8");
}

function manifestLines(id: string, entry: string): readonly string[] {
	return [
		"api_version: 2",
		`id: ${id}`,
		"name: Demo",
		`entry: ${JSON.stringify(entry)}`,
		"provides:",
		"  tools: []",
		"  hooks: []",
		"  commands: []",
		"requires_env: []",
		"capabilities: []",
	];
}

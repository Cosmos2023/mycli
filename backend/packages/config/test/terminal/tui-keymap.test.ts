import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "smol-toml";
import {
	ConfigError,
	resetTuiKeymap,
	resolveConfigWithMetadata,
} from "../../src/index.ts";

test("layered TUI keymaps expose normalized effective bindings and provenance", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[tui.keymap.app]",
		'help = " CTRL+H "',
		"tools_expand = []",
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[tui.keymap.app]",
		'help = ["f1", "F1"]',
	]);

	const resolved = await resolveConfigWithMetadata({
		homeDir,
		workspaceRoot,
		env: {},
		workspaceTrust: "trusted",
	});

	assert.deepEqual(resolved.shellSettings.keymap.bindings["app.help"], ["f1"]);
	assert.deepEqual(resolved.shellSettings.keymap.bindings["app.tools.expand"], []);
	assert.deepEqual(resolved.shellSettings.keymap.bindings["tui.input.submit"], ["enter"]);
	assert.equal(resolved.shellSettings.keymap.sources["app.help"], "project");
	assert.deepEqual(resolved.shellSettings.keymap.overridden["app.help"], ["user"]);
	assert.equal(resolved.shellSettings.keymap.sources["app.tools.expand"], "user");
});

test("TUI keymap validation rejects conflicts, unknown actions, invalid keys, and required unbinding", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	for (const [source, expectedPath] of [
		[["[tui.keymap.app]", 'help = "ctrl+p"'], "tui.keymap.app.command_palette"],
		[["[tui.keymap.app]", 'missing_action = "f1"'], "tui.keymap.app.missing_action"],
		[["[tui.keymap.app]", 'help = "mouse1"'], "tui.keymap.app.help"],
		[["[tui.keymap.selector]", "cancel = []"], "tui.keymap.selector.cancel"],
	] as const) {
		await writeToml(join(homeDir, ".mycli", "config.toml"), source);
		await assert.rejects(
			() => resolveConfigWithMetadata({ homeDir, workspaceRoot, env: {}, workspaceTrust: "untrusted" }),
			(error: unknown) => error instanceof ConfigError && error.diagnostic.keyPath === expectedPath,
		);
	}
});

test("TUI keymap reset removes only the user keymap table", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	const path = join(homeDir, ".mycli", "config.toml");
	await writeToml(path, [
		'custom = "keep"',
		'tui_theme = "light"',
		"[tui.keymap.app]",
		'help = "f1"',
	]);

	assert.equal(await resetTuiKeymap({
		homeDir,
		workspaceRoot,
		env: {},
		workspaceTrust: "untrusted",
	}), true);
	const payload = parse(await readFile(path, "utf8")) as Record<string, unknown>;
	assert.equal(payload.custom, "keep");
	assert.equal(payload.tui_theme, "light");
	assert.deepEqual(payload.tui, {});
	const resolved = await resolveConfigWithMetadata({ homeDir, workspaceRoot, env: {}, workspaceTrust: "untrusted" });
	assert.deepEqual(resolved.shellSettings.keymap.bindings["app.help"], ["?"]);
});

async function configTree(t: TestContext): Promise<{ homeDir: string; workspaceRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-keymap-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await Promise.all([
		mkdir(join(homeDir, ".mycli"), { recursive: true }),
		mkdir(workspaceRoot, { recursive: true }),
	]);
	return { homeDir, workspaceRoot };
}

async function writeToml(path: string, lines: readonly string[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

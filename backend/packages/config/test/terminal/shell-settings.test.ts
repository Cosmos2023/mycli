import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "smol-toml";
import {
	loadShellSettings,
	loadShellSettingsState,
	SHELL_SETTING_DESCRIPTORS,
	saveShellSetting,
	saveShellSettings,
} from "../../src/index.ts";

test("shell settings load defaults and persist normalized visual settings", async (t) => {
	const homeDir = await temporaryDirectory(t);
	assert.deepEqual(await loadShellSettings({ homeDir }), {
		statusbar_mode: "full",
		view_mode: "default",
		theme: "dark",
		hide_thinking: true,
		tool_details_default: "collapsed",
		hardware_cursor: false,
		clear_on_shrink: true,
		terminal_progress: true,
		subagent_density: "normal",
		color_mode: "auto",
		reduced_motion: false,
		glyph_mode: "auto",
		high_contrast: false,
	});

	const directory = join(homeDir, ".mycli");
	const path = join(directory, "config.toml");
	await mkdir(directory, { recursive: true });
	await writeFile(path, [
		"[model]",
		'provider = "openai"',
		'name = "gpt-test"',
		"",
	].join("\n"), "utf8");

	const saved = await saveShellSettings({
		homeDir,
		settings: {
			statusbarMode: "compact",
			view_mode: "verbose",
			theme: "light",
			hideThinking: false,
			toolDetailsDefault: "expanded",
			hardwareCursor: true,
			clearOnShrink: false,
			terminalProgress: false,
			subagentDensity: "detailed",
			colorMode: "none",
			reducedMotion: true,
			glyphMode: "ascii",
			highContrast: true,
		},
	});
	assert.deepEqual(saved, {
		statusbar_mode: "compact",
		view_mode: "verbose",
		theme: "light",
		hide_thinking: false,
		tool_details_default: "expanded",
		hardware_cursor: true,
		clear_on_shrink: false,
		terminal_progress: false,
		subagent_density: "detailed",
		color_mode: "none",
		reduced_motion: true,
		glyph_mode: "ascii",
		high_contrast: true,
	});
	assert.deepEqual(await loadShellSettings({ homeDir }), saved);
	const payload = parse(await readFile(path, "utf8")) as Record<string, unknown>;
	assert.deepEqual(payload.model, { provider: "openai", name: "gpt-test" });
	assert.equal(payload.tui_statusbar_mode, "compact");
	assert.equal(payload.view_mode, "verbose");
});

test("shell setting descriptors are complete and report per-setting user sources", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "config.toml"), [
		'tui_theme = "light"',
		'hideThinking = false',
		"",
	].join("\n"), "utf8");

	assert.equal(SHELL_SETTING_DESCRIPTORS.length, 13);
	assert.equal(new Set(SHELL_SETTING_DESCRIPTORS.map((item) => item.key)).size, 13);
	assert.equal(new Set(SHELL_SETTING_DESCRIPTORS.map((item) => item.clientKey)).size, 13);
	const loaded = await loadShellSettingsState({ homeDir });
	assert.equal(loaded.settings.theme, "light");
	assert.equal(loaded.settings.hide_thinking, false);
	assert.equal(loaded.sources.theme, "user");
	assert.equal(loaded.sources.hide_thinking, "user");
	assert.equal(loaded.sources.statusbar_mode, "default");
});

test("single shell setting persistence does not claim unrelated defaults", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	const path = join(directory, "config.toml");
	await mkdir(directory, { recursive: true });
	await writeFile(path, 'custom = "keep"\n', "utf8");

	const loaded = await saveShellSetting({
		homeDir,
		key: "tui.theme",
		value: "light",
	});

	assert.equal(loaded.settings.theme, "light");
	assert.equal(loaded.sources.theme, "user");
	for (const item of SHELL_SETTING_DESCRIPTORS) {
		if (item.settingKey !== "theme") assert.equal(loaded.sources[item.settingKey], "default");
	}
	assert.deepEqual(parse(await readFile(path, "utf8")), {
		custom: "keep",
		tui_theme: "light",
	});
});

test("shell settings reject invalid values without replacing the current config", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	const path = join(directory, "config.toml");
	const current = 'custom = "keep"\n';
	await mkdir(directory, { recursive: true });
	await writeFile(path, current, "utf8");

	await assert.rejects(
		() => saveShellSettings({ homeDir, settings: { theme: "purple" } }),
		/shell_settings_invalid: unsupported theme/,
	);
	assert.equal(await readFile(path, "utf8"), current);
});

test("shell settings preserve comments and CRLF and skip identical replacements", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	const path = join(directory, "config.toml");
	await mkdir(directory, { recursive: true });
	await writeFile(path, [
		"# keep shell comment",
		'custom = "keep" # keep inline comment',
		'statusbarMode = "compact"',
		'viewMode = "verbose"',
		"",
		"[plugins]",
		'enabled = ["demo"]',
		"",
	].join("\r\n"), "utf8");

	const settings = {
		statusbarMode: "compact",
		viewMode: "verbose",
		theme: "light",
		hideThinking: false,
		toolDetailsDefault: "expanded",
		hardwareCursor: true,
		clearOnShrink: false,
		terminalProgress: false,
		subagentDensity: "detailed",
	};
	await saveShellSettings({ homeDir, settings });
	const raw = await readFile(path, "utf8");
	const payload = parse(raw) as Record<string, unknown>;
	assert.match(raw, /# keep shell comment\r\n/u);
	assert.match(raw, /custom = "keep" # keep inline comment\r\n/u);
	assert.equal(raw.includes("\n") && !raw.includes("\r\n"), false);
	assert.equal(payload.statusbarMode, undefined);
	assert.equal(payload.viewMode, undefined);
	assert.equal(payload.tui_statusbar_mode, "compact");
	assert.equal(payload.view_mode, "verbose");
	assert.deepEqual(payload.plugins, { enabled: ["demo"] });

	await saveShellSettings({
		homeDir,
		settings,
		failpoint: () => { throw new Error("no-op must not replace"); },
	});
	assert.equal(await readFile(path, "utf8"), raw);
});

test("shell settings preserve the current config on atomic replacement failure", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	const path = join(directory, "config.toml");
	const current = 'custom = "keep"\n';
	await mkdir(directory, { recursive: true });
	await writeFile(path, current, "utf8");

	await assert.rejects(
		() => saveShellSettings({
			homeDir,
			settings: { theme: "light" },
			failpoint: () => { throw new Error("private-shell-sentinel"); },
		}),
		(error: unknown) => error instanceof Error
			&& error.message === "shell_settings_write_failed: unable to update user config"
			&& !error.message.includes("private-shell-sentinel"),
	);
	assert.equal(await readFile(path, "utf8"), current);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-shell-settings-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

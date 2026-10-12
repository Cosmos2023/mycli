import assert from "node:assert/strict";
import test from "node:test";
import { SHELL_SETTING_DESCRIPTORS } from "@mycli/config";
import { buildNodeSettingsCatalog } from "../src/node-runtime/node-settings-catalog.ts";

test("settings catalog exposes only the appearance preferences plus a session summary", () => {
	const catalog = buildNodeSettingsCatalog({
		settings: { theme: "light", statusbar_mode: "compact" },
		sources: { theme: "user", statusbar_mode: "user" },
		terminalCapabilities: {
			color_mode: "256",
			glyph_mode: "ascii",
			terminal_kind: "standard",
			progress_visible: true,
			progress_animated: false,
			guidance: ["Unicode glyph support is unavailable; using ASCII indicators."],
		},
		provider: "openai",
		model: "gpt-test",
		reasoningEffort: "high",
		credential: { ready: true, source: "stored" },
		permissions: { active: "workspace" },
		trust: { state: "trusted" },
		context: { used_tokens: 1200, max_tokens: 10000 },
	});
	const categories = catalog.categories as Array<Record<string, unknown>>;
	const items = catalog.items as Array<Record<string, unknown>>;

	assert.equal(catalog.version, 1);
	assert.equal(
		catalog.summary,
		"openai/gpt-test · high · workspace · trusted · 1,200/10,000 tokens",
	);
	assert.deepEqual(categories.map((item) => item.id), ["appearance"]);
	assert.deepEqual(items.map((item) => item.id), [
		...SHELL_SETTING_DESCRIPTORS.map((descriptor) => descriptor.key),
		"terminal.capabilities",
		"keymap.reset",
	]);
	assert.ok(items.every((item) => item.category === "appearance"));
	assert.deepEqual(items.find((item) => item.id === "tui.theme"), {
		id: "tui.theme",
		category: "appearance",
		kind: "choice",
		label: "Theme",
		description: "Selects the terminal color theme",
		value: "light",
		source: "user",
		scope: "user",
		allowed_values: ["dark", "light"],
		client_key: "theme",
		config_key: "tui.theme",
		locked: false,
		restart_required: false,
		search_terms: ["theme", "theme", "tui.theme"],
	});
	assert.equal(items.find((item) => item.id === "keymap.reset")?.action, "reset_keymap");
	assert.deepEqual(items.find((item) => item.id === "terminal.capabilities"), {
		id: "terminal.capabilities",
		category: "appearance",
		kind: "status",
		label: "Terminal capabilities",
		description: "Unicode glyph support is unavailable; using ASCII indicators.",
		value: "256 / ascii / static progress",
		source: "standard",
		scope: "runtime",
		locked: false,
		restart_required: false,
		search_terms: ["color", "unicode", "ascii", "motion", "contrast", "terminal"],
	});
});

test("settings catalog bounds private values and flags missing credentials", () => {
	const privateValue = `private\n${"x".repeat(400)}`;
	const catalog = buildNodeSettingsCatalog({
		settings: {},
		provider: privateValue,
		model: privateValue,
		credential: { ready: false, source: "missing" },
		permissions: {},
		trust: {},
		context: {},
	});
	const serialized = JSON.stringify(catalog);

	assert.match(String(catalog.summary), /workspace · unknown · no context data · credentials missing$/u);
	assert.ok(String(catalog.summary).length <= 400);
	assert.equal(serialized.includes("\n"), false);
	assert.ok(serialized.length < 32_000);
});

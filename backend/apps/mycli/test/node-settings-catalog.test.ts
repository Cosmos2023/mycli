import assert from "node:assert/strict";
import test from "node:test";
import { SHELL_SETTING_DESCRIPTORS } from "@mycli/config";
import { TUI_KEYMAP_ACTIONS } from "@mycli/contracts";
import { buildNodeSettingsCatalog } from "../src/node-runtime/node-settings-catalog.ts";

test("settings catalog projects seven bounded categories and canonical visual descriptors", () => {
	const catalog = buildNodeSettingsCatalog({
		settings: { theme: "light", statusbar_mode: "compact" },
		sources: { theme: "user", statusbar_mode: "user" },
		keymap: {
			bindings: { "app.help": ["ctrl+h"] },
			sources: { "app.help": "user" },
		},
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
		permissions: {
			active: "workspace",
			effective: { source: "managed" },
			sandbox_readiness: { state: "ready", isolation: "macos_seatbelt" },
		},
		trust: { state: "trusted", source: "user_store" },
		context: { used_tokens: 1200, max_tokens: 10000, source: "provider" },
		integrationsAvailable: true,
		update: {
			schemaVersion: 1,
			packageName: "@cosmos2023/mycli",
			currentVersion: "0.1.0",
			checkOnStartup: true,
			availability: "available",
			cacheState: "fresh",
			latestVersion: "0.2.0",
			install: {
				method: "npm",
				command: "npm install -g @cosmos2023/mycli@latest",
				fallback: false,
			},
		},
	});
	const categories = catalog.categories as Array<Record<string, unknown>>;
	const items = catalog.items as Array<Record<string, unknown>>;

	assert.equal(catalog.version, 1);
	assert.deepEqual(categories.map((item) => item.id), [
		"model",
		"providers",
		"permissions",
		"appearance",
		"sessions",
		"integrations",
		"diagnostics",
	]);
	assert.equal(
		items.filter((item) => item.category === "appearance").length,
		SHELL_SETTING_DESCRIPTORS.length + TUI_KEYMAP_ACTIONS.length + 2,
	);
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
	assert.equal(items.find((item) => item.id === "permissions.profile")?.source, "managed");
	assert.equal(items.find((item) => item.id === "keymap.app.help")?.value, "ctrl+h");
	assert.equal(items.find((item) => item.id === "keymap.app.help")?.source, "user");
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
	assert.equal(items.find((item) => item.id === "sessions.context")?.value, "1,200 / 10,000 tokens");
	assert.deepEqual(items.find((item) => item.id === "diagnostics.updates"), {
		id: "diagnostics.updates",
		category: "diagnostics",
		kind: "action",
		label: "Updates",
		description: "Inspect cached update status and manual installation guidance",
		value: "0.2.0 available",
		source: "update_cache",
		scope: "user",
		action: "run_command",
		action_args: "/update",
		command: "/update",
		locked: false,
		restart_required: false,
		search_terms: ["upgrade", "version", "npm"],
	});
});

test("settings catalog keeps unavailable actions and private values bounded", () => {
	const privateValue = `private\n${"x".repeat(400)}`;
	const catalog = buildNodeSettingsCatalog({
		settings: {},
		provider: privateValue,
		model: privateValue,
		permissions: {},
		trust: {},
		context: {},
		integrationsAvailable: false,
	});
	const serialized = JSON.stringify(catalog);
	const items = catalog.items as Array<Record<string, unknown>>;
	const integrations = items.filter((item) => item.category === "integrations");
	const updates = items.find((item) => item.id === "diagnostics.updates");

	assert.deepEqual(integrations.map((item) => item.command), ["/mcp", "/plugins", "/skills", "/hooks"]);
	for (const item of integrations) {
		assert.equal(item.locked, true);
		assert.equal(item.lock_reason, "No integration resource service is configured");
		assert.equal(item.action, "run_command");
		assert.equal(item.action_args, item.command);
	}
	assert.equal(updates?.locked, true);
	assert.equal(updates?.lock_reason, "Update status is unavailable");
	assert.equal(serialized.includes("\n"), false);
	assert.ok(serialized.length < 32_000);
});

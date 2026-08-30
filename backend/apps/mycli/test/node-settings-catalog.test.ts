import assert from "node:assert/strict";
import test from "node:test";
import { buildNodeSettingsCatalog } from "../src/node-runtime/node-settings-catalog.ts";

test("settings catalog projects seven bounded categories and canonical visual descriptors", () => {
	const catalog = buildNodeSettingsCatalog({
		settings: { theme: "light", statusbar_mode: "compact" },
		sources: { theme: "user", statusbar_mode: "user" },
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
	assert.equal(items.filter((item) => item.category === "appearance").length, 9);
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
	assert.equal(items.find((item) => item.id === "sessions.context")?.value, "1,200 / 10,000 tokens");
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
	const integrations = items.find((item) => item.id === "integrations.resources");

	assert.equal(integrations?.locked, true);
	assert.equal(integrations?.lock_reason, "No integration resource service is configured");
	assert.equal(serialized.includes("\n"), false);
	assert.ok(serialized.length < 12_000);
});

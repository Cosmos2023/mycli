import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	buildConfigReference,
	configSettingDescriptors,
	renderConfigExampleToml,
	renderConfigReferenceJson,
	renderConfigReferenceMarkdown,
	resolveConfig,
} from "../../src/index.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

test("generated configuration reference matches the canonical descriptors", async () => {
	const config = await resolveConfig({
		homeDir: `${REPOSITORY_ROOT}.generated-config-reference/home`,
		workspaceRoot: `${REPOSITORY_ROOT}.generated-config-reference/workspace`,
		systemConfigPath: `${REPOSITORY_ROOT}.generated-config-reference/system.toml`,
		env: {},
		workspaceTrust: "untrusted",
		createSessionId: () => "configuration-reference-test",
	});
	const reference = buildConfigReference(config);
	const descriptors = configSettingDescriptors();

	assert.deepEqual(reference.settings.map((setting) => setting.key), descriptors.map((setting) => setting.key));
	assert.equal(new Set(reference.settings.map((setting) => setting.key)).size, reference.settings.length);
	for (const setting of reference.settings) {
		assert.notEqual(setting.description.trim(), "");
		assert.notEqual(setting.canonicalPath.trim(), "");
	}
	assert.equal(
		reference.settings.find((setting) => setting.key === "model.web_search_mode")?.valueKind,
		"string",
	);

	for (const [relativePath, expected] of [
		["docs/reference/configuration.md", renderConfigReferenceMarkdown(config)],
		["docs/reference/configuration-reference.json", renderConfigReferenceJson(config)],
		["docs/reference/config.example.toml", renderConfigExampleToml(config)],
	] as const) {
		const actual = await readFile(new URL(`../../../../../${relativePath}`, import.meta.url), "utf8");
		assert.equal(actual, expected, `${relativePath} drifted from the canonical descriptors`);
		assert.doesNotMatch(actual, /(?:\/Users\/|[A-Z]:\\\\Users\\\\)/u);
	}
});

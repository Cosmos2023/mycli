import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectExtensionChecks } from "../src/management/doctor/check-extensions.ts";

test("extension doctor isolates malformed metadata and reports migration without probing runtimes", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-doctor-extensions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	const builtinSkillRoot = join(root, "builtin-skills");
	const mycliRoot = join(workspaceRoot, ".mycli");
	await mkdir(join(mycliRoot, "skills"), { recursive: true });
	await mkdir(join(mycliRoot, "plugins", "legacy"), { recursive: true });
	await mkdir(join(mycliRoot, "plugins", "healthy", "dist"), { recursive: true });
	await mkdir(builtinSkillRoot, { recursive: true });

	await writeFile(join(mycliRoot, "hooks.json"), "{secret: hook-test-secret", "utf8");
	await writeFile(join(mycliRoot, "skills", "broken.md"), [
		"---",
		'name = "../unsafe"',
		'description = "skill-test-secret"',
		"---",
		"private skill prompt",
	].join("\n"), "utf8");
	await writeFile(join(mycliRoot, "plugins", "legacy", "__init__.py"), "TOKEN='python-test-secret'\n", "utf8");
	await writeFile(join(mycliRoot, "plugins", "legacy", "plugin.yaml"), "name: Legacy\n", "utf8");
	await writeFile(join(mycliRoot, "plugins", "healthy", "dist", "index.js"), "export const unused = true;\n", "utf8");
	await writeFile(join(mycliRoot, "plugins", "healthy", "plugin.yaml"), [
		"api_version: 2",
		"id: healthy",
		"name: Healthy",
		"entry: dist/index.js",
		"provides:",
		"  tools: []",
		"  hooks: []",
		"  commands: []",
		"requires_env: [DOCTOR_FIXTURE_KEY]",
		"capabilities: []",
	].join("\n"), "utf8");
	await writeFile(join(mycliRoot, "config.toml"), [
		"[plugins]",
		'enabled = ["healthy", "legacy"]',
		"disabled = []",
	].join("\n"), "utf8");
	await writeFile(join(mycliRoot, "mcp_servers.toml"), [
		"[servers.files]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
	].join("\n"), "utf8");

	const checks = await collectExtensionChecks({
		workspaceRoot,
		homeDir,
		env: { DOCTOR_FIXTURE_KEY: "plugin-env-test-secret" },
		builtinSkillRoot,
	}, new AbortController().signal);
	const byName = new Map(checks.map((check) => [check.name, check]));

	assert.deepEqual(checks.map((check) => check.name), [
		"hooks",
		"plugins",
		"plugin_migration",
		"skills",
		"subagents",
		"mcp",
	]);
	assert.equal(byName.get("hooks")?.status, "failed");
	assert.equal(byName.get("plugins")?.status, "ok");
	assert.equal(byName.get("plugin_migration")?.status, "warning");
	assert.match(byName.get("plugin_migration")?.message ?? "", /migration_required/u);
	assert.equal(byName.get("skills")?.status, "warning");
	assert.equal(byName.get("subagents")?.status, "ok");
	assert.equal(byName.get("subagents")?.message, "mode=prompt_driven profiles=disabled");
	assert.equal(byName.get("mcp")?.status, "ok");
	assert.match(byName.get("plugins")?.message ?? "", /runtime=not_probed/u);
	assert.match(byName.get("mcp")?.message ?? "", /runtime=not_probed/u);
	assert.doesNotMatch(
		JSON.stringify(checks),
		/hook-test-secret|skill-test-secret|python-test-secret|plugin-env-test-secret|private.*prompt/u,
	);
	const missingEnv = await collectExtensionChecks({ workspaceRoot, homeDir, env: {}, builtinSkillRoot }, new AbortController().signal);
	assert.equal(missingEnv.find((check) => check.name === "plugins")?.status, "failed");
	assert.match(missingEnv.find((check) => check.name === "plugins")?.detail ?? "", /missing_required_env/u);
	const untrusted = await collectExtensionChecks({ workspaceRoot, homeDir, env: {}, builtinSkillRoot, includeRepository: false }, new AbortController().signal);
	assert.equal(untrusted.find((check) => check.name === "plugins")?.status, "ok");
	assert.equal(untrusted.find((check) => check.name === "plugin_migration")?.message, "migration_required=0");
	assert.match(untrusted.find((check) => check.name === "mcp")?.message ?? "", /configured=0/u);
});

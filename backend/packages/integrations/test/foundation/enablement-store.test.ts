import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IntegrationEnablementError, IntegrationEnablementStore, integrationEnabled, integrationSourceIdentity } from "../../src/foundation/enablement-store.ts";
import { SkillRegistry, skillIdentity } from "../../src/skills/registry.ts";

test("enablement reads create no configuration and saved overrides survive reopening", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-enablement-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	const store = new IntegrationEnablementStore({ homeDir });
	const empty = await store.load();
	await assert.rejects(access(join(homeDir, ".mycli")), { code: "ENOENT" });
	const id = integrationSourceIdentity(["skill", "/repo/SKILL.md"]);
	const saved = await store.setEnabled({ kind: "skill", id, enabled: false, revision: empty.revision }, new AbortController().signal);
	assert.deepEqual(await new IntegrationEnablementStore({ homeDir }).load(), saved);
	assert.equal(integrationEnabled(saved, "skill", id), false);
	assert.equal(integrationEnabled(saved, "hook", id), true);
	assert.equal(integrationEnabled(saved, "skill", integrationSourceIdentity(["skill", "/other/SKILL.md"])), true);
});

test("concurrent updates with one revision admit only one writer", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-enablement-race-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	const first = new IntegrationEnablementStore({ homeDir });
	const second = new IntegrationEnablementStore({ homeDir });
	const { revision } = await first.load();
	const results = await Promise.allSettled([first, second].map((store, index) => store.setEnabled({
		kind: "hook", id: integrationSourceIdentity([String(index)]), enabled: false, revision,
	}, new AbortController().signal)));
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	const rejected = results.find((result) => result.status === "rejected");
	assert.ok(rejected?.status === "rejected" && rejected.reason instanceof IntegrationEnablementError);
	assert.equal(rejected.reason.code, "integration_settings_changed");
	assert.equal((await first.load()).entries.length, 1);
});

test("malformed settings cannot be overwritten by an enablement action", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-enablement-invalid-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	const store = new IntegrationEnablementStore({ homeDir });
	const { revision } = await store.load();
	await mkdir(join(homeDir, ".mycli"));
	const path = join(homeDir, ".mycli", "integration-enablement.json");
	const original = '{"version":1,"entries": [invalid';
	await writeFile(path, original);
	await assert.rejects(store.load(), { code: "integration_settings_invalid" });
	await assert.rejects(store.setEnabled({ kind: "skill", id: integrationSourceIdentity(["one"]), enabled: false, revision },
		new AbortController().signal), { code: "integration_settings_invalid" });
	assert.equal(await readFile(path, "utf8"), original);
});

test("disabled skills remain inspectable but cannot be loaded or exposed to the model", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-skill-enablement-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	const userRoot = join(homeDir, "skills");
	await mkdir(userRoot);
	await writeFile(join(userRoot, "review.md"), "---\nname: review\ndescription: Review changes\n---\nCheck the diff.\n");
	const options = { builtinRoot: join(homeDir, "missing"), userRoot };
	const discovered = await SkillRegistry.discover(options);
	const skill = discovered.get("review")!;
	const store = new IntegrationEnablementStore({ homeDir });
	const { revision } = await store.load();
	const disabled = await store.setEnabled({ kind: "skill", id: skillIdentity(skill), enabled: false, revision }, new AbortController().signal);
	const registry = await SkillRegistry.discover({ ...options, enablement: disabled });
	assert.equal(registry.get("review"), undefined);
	assert.deepEqual(registry.list(), []);
	assert.equal(registry.listAll()[0]?.enabled, false);
	const enabled = await store.setEnabled({ kind: "skill", id: skillIdentity(skill), enabled: true, revision: disabled.revision }, new AbortController().signal);
	assert.equal((await SkillRegistry.discover({ ...options, enablement: enabled })).get("review")?.body, skill.body);
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	renderSkillCatalog,
	SkillRegistry,
} from "../../src/index.ts";

test("discovers TOML and YAML skills with deterministic source precedence", async (t) => {
	const fixture = await roots(t);
	await writeSkill(fixture.builtin, "review.md", [
		'name = "review"',
		'description = "Builtin review"',
	], "Builtin body");
	await writeSkill(fixture.user, "review.md", [
		'name = "review"',
		'description = "User review"',
	], "User body");
	await writeSkill(fixture.sharedRepo, "analyze.md", [
		"name: analyze",
		"description: Analyze the repository",
		"trigger_hints:",
		"  - inspect",
	], "Analyze body");
	await writeSkill(fixture.sharedRepo, "review.md", [
		'name = "review"',
		'description = "Shared review"',
	], "Shared body");
	await writeSkill(fixture.repo, "review/SKILL.md", [
		"name: review",
		"description: Repository review",
		"guardrails:",
		"  - Prefer correctness findings",
	], "Repository body");
	await writeFile(
		join(fixture.user, "broken.md"),
		"not frontmatter\nSECRET BODY MUST NOT LEAK\n",
		"utf8",
	);

	const registry = await SkillRegistry.discover(fixture);

	assert.equal(registry.get("review")?.sourceKind, "repo");
	assert.equal(registry.get("review")?.body, "Repository body");
	assert.deepEqual(registry.get("review")?.guardrails, ["Prefer correctness findings"]);
	assert.deepEqual(registry.get("analyze")?.triggerHints, ["inspect"]);
	assert.deepEqual(registry.list().map((skill) => skill.name), ["analyze", "review"]);
	assert.equal(registry.diagnostics().duplicateCount, 1);
	assert.equal(registry.diagnostics().issueCount, 1);
	assert.deepEqual(
		Object.keys(registry.diagnostics().issues[0] ?? {}).sort(),
		["errorClass", "fileLabel", "sourceKind"],
	);
	assert.equal(JSON.stringify(registry.diagnostics()).includes("SECRET BODY"), false);

	const catalog = renderSkillCatalog(registry);
	assert.match(catalog, /- analyze: Analyze the repository/);
	assert.match(catalog, /- review: Repository review/);
	assert.equal(catalog.includes("Repository body"), false);
	assert.equal(catalog.includes(fixture.repo), false);
});

test("keeps valid skills when malformed, oversized, and unsafe names are rejected", async (t) => {
	const fixture = await roots(t);
	await writeSkill(fixture.builtin, "valid.md", [
		'name = "valid"',
		'description = "Valid skill"',
	], "short");
	await writeSkill(fixture.user, "oversized.md", [
		'name = "oversized"',
		'description = "Too large"',
	], "body is longer than the configured limit");
	await writeSkill(fixture.repo, "unsafe.md", [
		'name = "../unsafe"',
		'description = "Unsafe name"',
	], "unsafe");

	const registry = await SkillRegistry.discover({ ...fixture, maxBodyChars: 8 });

	assert.deepEqual(registry.list().map((skill) => skill.name), ["valid"]);
	assert.equal(registry.diagnostics().issueCount, 2);
	assert.deepEqual(
		registry.diagnostics().issues.map((issue) => issue.errorClass).sort(),
		["invalid_name", "skill_body_too_large"],
	);
});

test("reserves complete usage guidance when skill descriptions exhaust the catalog budget", async (t) => {
	const fixture = await roots(t);
	for (const name of ["analyze", "review", "verify"]) {
		await writeSkill(fixture.repo, `${name}.md`, [
			`name = "${name}"`, `description = "${"Description ".repeat(40)}"`,
		], "PRIVATE SKILL BODY");
	}
	const registry = await SkillRegistry.discover(fixture);
	const complete = renderSkillCatalog(registry);
	const guidance = complete.slice(complete.indexOf("How to use skills:"));
	const budget = complete.length - 450;
	const bounded = renderSkillCatalog(registry, { maxChars: budget });
	assert.ok(bounded.length <= budget);
	assert.ok(bounded.includes("- analyze:"));
	assert.ok(!bounded.includes("- verify:"));
	assert.ok(bounded.endsWith(guidance));
	assert.ok(!bounded.includes("PRIVATE SKILL BODY"));
	assert.ok(!bounded.includes(fixture.repo));
	assert.equal(renderSkillCatalog(registry, { maxChars: guidance.length }), "");
	assert.throws(() => renderSkillCatalog(registry, { maxChars: 0 }), /invalid_skill_catalog_limit/u);
});

async function roots(t: TestContext): Promise<{
	readonly builtinRoot: string;
	readonly userRoot: string;
	readonly sharedRepoRoot: string;
	readonly repoRoot: string;
	readonly builtin: string;
	readonly user: string;
	readonly sharedRepo: string;
	readonly repo: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-skills-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const builtin = join(root, "builtin");
	const user = join(root, "home", ".mycli", "skills");
	const sharedRepo = join(root, "workspace", ".agents", "skills");
	const repo = join(root, "workspace", ".mycli", "skills");
	for (const directory of [builtin, user, sharedRepo, repo]) {
		await mkdir(directory, { recursive: true });
	}
	return {
		builtinRoot: builtin,
		userRoot: user,
		sharedRepoRoot: sharedRepo,
		repoRoot: repo,
		builtin,
		user,
		sharedRepo,
		repo,
	};
}

async function writeSkill(
	root: string,
	relativePath: string,
	frontmatter: readonly string[],
	body: string,
): Promise<void> {
	const target = join(root, relativePath);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, `---\n${frontmatter.join("\n")}\n---\n${body}\n`, "utf8");
}

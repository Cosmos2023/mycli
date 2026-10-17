import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyAgentRole, discoverAgentRoles } from "../../src/index.ts";

async function fixture(t: test.TestContext): Promise<{
	readonly homeDir: string;
	readonly workspaceRoot: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-agent-roles-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await mkdir(join(homeDir, ".mycli", "agents"), { recursive: true });
	await mkdir(join(workspaceRoot, ".mycli", "agents"), { recursive: true });
	return { homeDir, workspaceRoot };
}

test("roles come from the user and repository directories, and the repository wins", async (t) => {
	const { homeDir, workspaceRoot } = await fixture(t);
	await writeFile(join(homeDir, ".mycli", "agents", "reviewer.toml"),
		'name = "reviewer"\ndescription = "User reviewer."\ntools = ["Read"]\n');
	await writeFile(join(homeDir, ".mycli", "agents", "planner.toml"),
		'name = "planner"\ndescription = "Plan work."\nmodel = "gpt-fast"\n');
	await writeFile(join(workspaceRoot, ".mycli", "agents", "reviewer.toml"),
		'name = "reviewer"\ndescription = "Repository reviewer."\n');

	const catalog = await discoverAgentRoles({ homeDir, workspaceRoot });

	assert.deepEqual(catalog.issues, []);
	assert.deepEqual(catalog.roles.map((role) => [
		role.name, role.description, role.sourceKind, role.model ?? null, role.tools ?? null,
	]), [
		["planner", "Plan work.", "user", "gpt-fast", null],
		["reviewer", "Repository reviewer.", "repo", null, null],
	]);
});

test("a workspace that is not trusted contributes no roles", async (t) => {
	const { homeDir, workspaceRoot } = await fixture(t);
	await writeFile(join(workspaceRoot, ".mycli", "agents", "reviewer.toml"),
		'name = "reviewer"\ndescription = "Repository reviewer."\n');

	const catalog = await discoverAgentRoles({ homeDir, workspaceRoot, includeRepository: false });

	assert.deepEqual(catalog.roles, []);
});

test("a malformed role file is reported instead of loaded", async (t) => {
	const { homeDir, workspaceRoot } = await fixture(t);
	const write = (file: string, text: string): Promise<void> =>
		writeFile(join(homeDir, ".mycli", "agents", file), text);
	await write("bad-name.toml", 'name = "Reviewer"\ndescription = "Wrong case."\n');
	await write("no-description.toml", 'name = "planner"\n');
	await write("unknown-field.toml", 'name = "planner"\ndescription = "Plan."\ntools = ["Read"]\nextra = "x"\n');
	await write("bad-tools.toml", 'name = "planner"\ndescription = "Plan."\ntools = "Read"\n');
	await write("broken.toml", 'name = "planner\n');

	const catalog = await discoverAgentRoles({ homeDir, workspaceRoot });

	assert.deepEqual(catalog.roles, []);
	assert.deepEqual(catalog.issues.map((issue) => issue.errorClass).sort(), [
		"role_description_invalid",
		"role_name_invalid",
		"role_tools_invalid",
		"role_unknown_field",
		"toml_invalid",
	]);
});

test("a role's tool allowlist only ever narrows what the caller may delegate", () => {
	const role = {
		name: "reviewer", description: "Read-only review.", sourcePath: "/w/.mycli/agents/reviewer.toml",
		sourceKind: "repo" as const, tools: Object.freeze(["Read", "Grep"]),
	};
	assert.deepEqual(applyAgentRole(role, ["Read", "Shell"]), ["Read"]);
	assert.deepEqual(applyAgentRole(role, []), []);
	assert.deepEqual(applyAgentRole({ ...role, tools: undefined }, ["Shell"]), ["Shell"]);
	assert.deepEqual(applyAgentRole(undefined, ["Shell"]), ["Shell"]);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BUILTIN_SUBAGENT_PROFILES,
	GLOBAL_CHILD_TOOL_DENYLIST,
	SubagentProfileRegistry,
} from "../src/index.ts";

test("subagent profile builtins use current Node tools without implicit budgets", () => {
	assert.deepEqual(BUILTIN_SUBAGENT_PROFILES.map((profile) => profile.id), [
		"executor",
		"explore",
		"review",
	]);
	assert.deepEqual(BUILTIN_SUBAGENT_PROFILES[0]?.allowedTools, [
		"Read",
		"Edit",
		"Patch",
		"Write",
	]);
	assert.deepEqual(BUILTIN_SUBAGENT_PROFILES[1]?.allowedTools, ["Read"]);
	assert.deepEqual(BUILTIN_SUBAGENT_PROFILES[2]?.allowedTools, ["Read"]);
	for (const profile of BUILTIN_SUBAGENT_PROFILES) {
		assert.deepEqual(profile.budget, {});
		assert.deepEqual(profile.deniedTools, GLOBAL_CHILD_TOOL_DENYLIST);
	}
});

test("subagent profile discovery preserves source and directory precedence", async (t) => {
	const fixture = await profileFixture(t);
	await writeToml(join(fixture.homeDir, ".mycli", "subagents", "executor.toml"), {
		id: "executor",
		description: "User subagents",
		instruction: "First override.",
		allowedTools: ["Read"],
	});
	await writeMarkdown(
		join(fixture.homeDir, ".mycli", "agents", "executor.md"),
		[
			'name = "executor"',
			'description = "User agents"',
			'tools = ["Read"]',
		],
		"Second override.",
	);
	await writeToml(join(fixture.workspaceRoot, ".mycli", "subagents", "executor.toml"), {
		id: "executor",
		description: "Repo subagents",
		instruction: "Third override.",
		allowedTools: ["Read"],
	});
	await writeMarkdown(
		join(fixture.workspaceRoot, ".mycli", "agents", "executor.md"),
		[
			"name: executor",
			"description: Repo agents",
			"tools: Read",
		],
		"Final override.",
	);

	const registry = await SubagentProfileRegistry.discover(fixture);
	const executor = registry.get("executor");

	assert.equal(executor?.sourceKind, "repo");
	assert.equal(executor?.sourceDirectory, "agents");
	assert.equal(executor?.description, "Repo agents");
	assert.equal(executor?.prompt, "Final override.");
	assert.match(executor?.fileLabel ?? "", /\.mycli\/agents\/executor\.md$/u);
	assert.equal(registry.diagnostics().duplicateCount, 4);
});

test("subagent profiles load TOML and Markdown aliases from agents and subagents", async (t) => {
	const fixture = await profileFixture(t);
	await writeToml(join(fixture.homeDir, ".mycli", "agents", "toml-agent.toml"), {
		name: "toml-agent",
		description: "TOML agent",
		systemPrompt: "Inspect TOML.",
		allowedTools: ["Read", "Write"],
		deniedTools: ["Shell"],
		model: "gpt-test",
		enabled: true,
		budget: {
			maxTurns: 5,
			maxToolCalls: 9,
			noProgressTurnLimit: 2,
		},
	});
	await writeMarkdown(
		join(fixture.workspaceRoot, ".mycli", "subagents", "yaml-agent.md"),
		[
			"name: yaml-agent",
			"description: YAML agent",
			"allowedTools: [Read, Patch]",
			"disallowedTools: [Write]",
			"model: gpt-yaml",
			"enabled: true",
			"maxTurns: 7",
			"maxToolCalls: 11",
			"noProgressTurnLimit: 3",
		],
		"Inspect YAML.\nReturn facts.",
	);
	await writeMarkdown(
		join(fixture.homeDir, ".mycli", "subagents", "disabled.md"),
		[
			'name = "disabled"',
			'description = "Disabled profile"',
			'tools = ["Read"]',
			"enabled = false",
		],
		"Do not run.",
	);

	const registry = await SubagentProfileRegistry.discover(fixture);
	const toml = registry.get("toml-agent");
	const markdown = registry.get("yaml-agent");

	assert.deepEqual(toml, {
		id: "toml-agent",
		description: "TOML agent",
		prompt: "Inspect TOML.",
		model: "gpt-test",
		allowedTools: ["Read", "Write"],
		deniedTools: ["Shell"],
		budget: { maxTurns: 5, maxToolCalls: 9, noProgressTurnLimit: 2 },
		sourceKind: "user",
		sourceDirectory: "agents",
		fileLabel: join(fixture.homeDir, ".mycli", "agents", "toml-agent.toml"),
	});
	assert.deepEqual(markdown?.allowedTools, ["Read", "Patch"]);
	assert.deepEqual(markdown?.deniedTools, ["Write"]);
	assert.deepEqual(markdown?.budget, {
		maxTurns: 7,
		maxToolCalls: 11,
		noProgressTurnLimit: 3,
	});
	assert.equal(markdown?.prompt, "Inspect YAML.\nReturn facts.");
	assert.equal(registry.get("disabled"), undefined);
	assert.equal(registry.records().find((record) => record.id === "disabled")?.status, "disabled");
});

test("subagent profile validation rejects invalid optional budgets", async (t) => {
	const fixture = await profileFixture(t);
	await writeToml(join(fixture.workspaceRoot, ".mycli", "subagents", "broken.toml"), {
		id: "broken",
		description: "Broken budget",
		instruction: "Never loads.",
		allowedTools: ["Read"],
		budget: { maxTurns: 0 },
	});

	const registry = await SubagentProfileRegistry.discover(fixture);

	assert.equal(registry.get("broken"), undefined);
	assert.equal(registry.records().find((record) => record.id === "broken")?.status, "failed");
	assert.ok(registry.diagnostics().issues.some((issue) =>
		issue.profileId === "broken" && issue.errorClass === "invalid_budget_max_turns"
	));
});

async function profileFixture(t: test.TestContext): Promise<{
	readonly homeDir: string;
	readonly workspaceRoot: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-subagent-profiles-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return {
		homeDir: join(root, "home"),
		workspaceRoot: join(root, "workspace"),
	};
}

async function writeToml(
	path: string,
	payload: Readonly<Record<string, unknown>>,
): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `${tomlLines(payload).join("\n")}\n`, "utf8");
}

function tomlLines(payload: Readonly<Record<string, unknown>>): string[] {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(payload)) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			lines.push(`[${key}]`);
			for (const [nestedKey, nestedValue] of Object.entries(value)) {
				lines.push(`${nestedKey} = ${tomlValue(nestedValue)}`);
			}
			continue;
		}
		lines.push(`${key} = ${tomlValue(value)}`);
	}
	return lines;
}

function tomlValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
	throw new Error("unsupported test TOML value");
}

async function writeMarkdown(
	path: string,
	frontmatter: readonly string[],
	body: string,
): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `---\n${frontmatter.join("\n")}\n---\n${body}\n`, "utf8");
}

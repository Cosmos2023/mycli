import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { builtinToolManifest } from "@mycli/tools";
import { ContextItemCoordinator } from "@mycli/runtime";
import { skillInvocationArtifactFromMetadata } from "@mycli/integrations";
import { createRuntimeIntegrationComposition } from "../src/node-runtime/integration-composition.ts";
import { createDefaultManagementServices } from "../src/management/services.ts";
import { parseCliMode } from "../src/management/parser.ts";
import { renderManagementResponse } from "../src/management/render.ts";

test("CLI installation flows into runtime skills and plugin diagnostics without provider work", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-cli-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const source = join(root, "bundle");
	await mkdir(homeDir);
	await mkdir(workspaceRoot);
	await mkdir(join(source, ".codex-plugin"), { recursive: true });
	await mkdir(join(source, "skills/review"), { recursive: true });
	await writeFile(join(source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "reviewer", apps: { apps: [] },
		mcpServers: { mcpServers: { invalid: { command: "never-run", env: false } } },
		hooks: { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "exit 0" }] }] } },
	}));
	await writeFile(join(source, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review changes\n---\nInspect the diff carefully.");
	const services = await createDefaultManagementServices({ homeDir, workspaceRoot, env: {} });
	const execute = async (args: readonly string[]): Promise<string> => {
		const mode = parseCliMode(["plugins", ...args]);
		if (mode.kind !== "management") assert.fail("management route missing");
		const response = await services.execute(mode.command);
		assert.equal(response.ok, true, JSON.stringify(response));
		return renderManagementResponse(mode.command, response);
	};
	assert.match(await execute(["add", source]), /reviewer installed/u);
	assert.match(await execute(["inspect", "reviewer"]), /format=codex/u);
	assert.match(await execute(["marketplace", "list"]), /marketplaces: 0/u);
	const composition = await createRuntimeIntegrationComposition({
		builtinManifest: builtinToolManifest(), workspaceRoot, homeDir, env: {}, projectConfigurationEnabled: false,
		parentSessionId: "plugin-test", parentTurnId: () => "turn", parentTools: () => [],
		createSubagentSupervisor: () => ({
			spawn: async () => assert.fail("no subagents should start"), output: () => assert.fail("no subagent output expected"),
			send: async () => assert.fail("no subagent messages expected"), interrupt: async () => false,
			waitFor: async () => undefined, unload: async () => false, list: () => [], recoverLegacyAbandoned: () => 0, close: async () => undefined,
		}),
		resolveSubagentSpawnContext: () => assert.fail("no subagents should spawn"),
	});
	t.after(() => composition.close());
	assert.match(composition.skillCatalog, /reviewer:review/u);
	assert.equal(composition.resources.find((item) => item.id === "plugin:reviewer")?.status, "partial");
	const plugin = composition.resources.find((item) => item.id === "plugin:reviewer");
	assert.equal(plugin?.command, "/plugins");
	assert.match(String(plugin?.inspection_detail), /Skills \(1\): review/u);
	assert.match(String(plugin?.inspection_detail), /MCP servers \(1\): invalid/u);
	assert.match(String(plugin?.inspection_detail), /Hooks \(1\): SessionStart/u);
	assert.match(String(plugin?.inspection_detail), /plugin_apps_unavailable/u);
	assert.ok(composition.resources.some((item) => item.type === "hook" && item.command === "/hooks"));
	assert.ok(composition.diagnostics.some((item) => String(item.errorClass).includes("plugin_mcp_env_invalid")));
	assert.equal(composition.hooks.length, 1);
	const skill = composition.registrations.find((registration) => registration.id === "skill:Skill")!;
	const result = await skill.adapter.execute({ name: "reviewer:review" }, { signal: new AbortController().signal,
		callId: "skill", ownerSessionId: "session", publishLifecycle: () => undefined });
	const context = new ContextItemCoordinator({ extractArtifact: skillInvocationArtifactFromMetadata }).contextItemFor({
		turnId: "turn", result: { ...result, callId: "skill", toolName: "Skill" },
	});
	assert.match(context!.text, /Inspect the diff carefully/u);
	assert.doesNotMatch(JSON.stringify(composition.diagnostics), new RegExp(root));
	assert.match(await execute(["disable", "reviewer"]), /disabled/u);
	assert.match(await execute(["list"]), /status=disabled/u);
	assert.match(await execute(["remove", "reviewer"]), /removed/u);
	assert.match(await execute(["list"]), /0 discovered/u);
});

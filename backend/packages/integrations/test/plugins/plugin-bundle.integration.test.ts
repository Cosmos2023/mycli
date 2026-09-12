import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { SandboxProfile } from "@mycli/tools";
import { discoverPlugins, McpClient, PluginPackageManager, pluginBundleContributions, pluginMcpServerId, PluginRuntime,
	skillInvocationArtifactFromMetadata, SkillRegistry, SkillTool } from "../../src/index.ts";

const signal = new AbortController().signal;
const unrestricted = (cwd: string): SandboxProfile => ({ mode: "danger-full-access", filesystem: "unrestricted",
	network: "enabled", workspaceRoot: cwd, cwd, writableRoots: [cwd] });

test("installed bundles activate namespaced skills, real MCP tools and root-aware command hooks", { timeout: 15_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-bundle-live-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const source = join(root, "source with spaces");
	await mkdir(homeDir);
	await mkdir(workspaceRoot);
	await mkdir(join(source, ".codex-plugin"), { recursive: true });
	await mkdir(join(source, "skills/review"), { recursive: true });
	await writeFile(join(source, "skills/review/SKILL.md"), "---\nname: review\ndescription: Inspect code\n---\nReview all changed lines.");
	await writeFile(join(source, "hook.mjs"), 'console.log(process.env.CODEX_PLUGIN_ROOT === process.env.CLAUDE_PLUGIN_ROOT ? "bundle-hook-ready" : "bad-root");');
	await writeFile(join(source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "demo", description: "Repository review helpers",
		mcpServers: { mcpServers: { fixture: { command: process.execPath, args: [fileURLToPath(new URL("../fixtures/mcp-stdio-server.mjs", import.meta.url))] },
			broken: { command: "unreachable", env: "malformed", required: true } } },
		hooks: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `"${process.execPath}" "$CODEX_PLUGIN_ROOT/hook.mjs"` }] }] } },
	}));
	const manager = new PluginPackageManager({ homeDir, workspaceRoot });
	assert.equal((await manager.execute({ action: "add", source }, signal)).ok, true);
	const discovery = await discoverPlugins({ homeDir, workspaceRoot });
	const contributions = pluginBundleContributions(discovery, { workspaceRoot, env: process.env, sandboxProfile: unrestricted });
	assert.equal(contributions.mcpServers.length, 1);
	assert.deepEqual(contributions.requiredMcpFailures, [pluginMcpServerId("demo", "broken")]);
	assert.deepEqual(contributions.issues, [{ pluginId: "demo", errorClass: "plugin_mcp_env_invalid" }]);
	const config = contributions.mcpServers[0]!;
	const client = new McpClient({ config, sandboxProfile: unrestricted(workspaceRoot) });
	t.after(() => client.close());
	const tools = await client.listTools(signal);
	assert.match(tools[0]!.serverInstructions!, /demo fixture: Repository review helpers/u);
	assert.deepEqual((await client.callTool("echo", { text: "bundle" }, signal)).content, [{ type: "text", text: "echo:bundle" }]);
	assert.equal((await client.listResources(signal)).length, 1);
	const registry = await SkillRegistry.discover({ builtinRoot: join(root, "empty"), userRoot: join(root, "empty"), pluginSkills: contributions.skills });
	assert.equal(registry.get("review"), undefined);
	assert.equal(registry.get("demo:review")?.pluginId, "demo");
	const result = await new SkillTool({ registry }).execute({ name: "demo:review" }, { signal, ownerSessionId: "session", callId: "skill", publishLifecycle: () => undefined });
	const artifact = skillInvocationArtifactFromMetadata(result.metadata);
	assert.equal(artifact?.name, "demo:review");
	assert.match(artifact!.text, /Review all changed lines/u);
	assert.match(artifact!.text, /Plugin root:/u);
	const hook = await contributions.hooks[0]!.handler({ point: "user_prompt_submit", sessionId: "session", turnId: "turn", metadata: {} }, signal);
	assert.equal(hook.action, "allow");
	if (hook.action !== "allow") assert.fail("hook failed");
	assert.deepEqual(hook.additionalContexts, ["bundle-hook-ready"]);
	const runtime = await PluginRuntime.load({ homeDir, workspaceRoot, env: {}, discovery,
		bundleIssues: contributions.issues, sandboxProfile: (manifest) => unrestricted(manifest.pluginRoot) }, signal);
	t.after(() => runtime.close());
	assert.equal(runtime.records[0]?.status, "partial");
	await manager.execute({ action: "disable", pluginId: "demo" }, signal);
	const disabled = pluginBundleContributions(await discoverPlugins({ homeDir, workspaceRoot }), { workspaceRoot, env: {}, sandboxProfile: unrestricted });
	assert.deepEqual(disabled, { skills: [], mcpServers: [], hooks: [], issues: [], requiredMcpFailures: [] });
});

test("bundle hooks preserve default disablement and capture explicit overrides", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-bundle-hook-enablement-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const source = join(root, "source");
	await mkdir(homeDir);
	await mkdir(workspaceRoot);
	await mkdir(join(source, ".codex-plugin"), { recursive: true });
	await writeFile(join(source, ".codex-plugin/plugin.json"), JSON.stringify({
		name: "disabled-hook",
		hooks: { hooks: [{ id: "probe", hook_point: "user_prompt_submit", enabled: false,
			command: [process.execPath, "-e", "console.log('enabled-hook-ran')"] }] },
	}));
	const manager = new PluginPackageManager({ homeDir, workspaceRoot });
	assert.equal((await manager.execute({ action: "add", source }, signal)).ok, true);
	const discovery = await discoverPlugins({ homeDir, workspaceRoot });
	const options = { workspaceRoot, env: {}, sandboxProfile: unrestricted };
	const invocation = { point: "user_prompt_submit" as const, sessionId: "session", turnId: "turn", metadata: {} };
	const defaults = pluginBundleContributions(discovery, options);
	assert.equal(defaults.hooks[0]?.origin?.enabled, false);
	assert.deepEqual(await defaults.hooks[0]!.handler(invocation, signal), { action: "allow" });
	let enabled = true;
	const overridden = pluginBundleContributions(discovery, { ...options, hookEnabled: () => enabled });
	enabled = false;
	assert.deepEqual(await overridden.hooks[0]!.handler(invocation, signal), { action: "allow", additionalContexts: ["enabled-hook-ran"] });
	const nextRun = pluginBundleContributions(discovery, { ...options, hookEnabled: () => enabled });
	assert.deepEqual(await nextRun.hooks[0]!.handler(invocation, signal), { action: "allow" });
});

test("qualified package names isolate identical skills and MCP server names; repository bundles require trust", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-bundle-namespaces-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await mkdir(homeDir);
	for (const id of ["demo@one", "demo@two"]) {
		const pluginRoot = join(workspaceRoot, ".mycli/plugins", id);
		await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
		await mkdir(join(pluginRoot, "skills/review"), { recursive: true });
		await writeFile(join(pluginRoot, ".codex-plugin/plugin.json"), JSON.stringify({ name: "demo", mcpServers: {
			mcpServers: { same: { type: "http", url: "https://example.invalid/mcp", startup_timeout_sec: 2, tool_timeout_sec: 70, required: true,
				default_tools_approval_mode: "prompt", enabled_tools: ["read"], sandbox: { network: "disabled" }, http_headers: { "X-Test": "${API_TOKEN}" } } },
		} }));
		await writeFile(join(pluginRoot, "skills/review/SKILL.md"), `---\nname: review\ndescription: Review\n---\n${id}`);
	}
	await writeFile(join(workspaceRoot, ".mycli/config.toml"), '[plugins]\nenabled = ["demo@one", "demo@two"]');
	const discovery = await discoverPlugins({ homeDir, workspaceRoot });
	const contributions = pluginBundleContributions(discovery, { workspaceRoot, env: { API_TOKEN: "private-value" }, sandboxProfile: unrestricted });
	assert.equal(new Set(contributions.mcpServers.map((item) => item.id)).size, 2);
	assert.equal(contributions.mcpServers[0]?.headers["X-Test"], "private-value");
	assert.equal(contributions.mcpServers[0]?.transport, "streamable_http");
	assert.equal(contributions.mcpServers[0]?.startupTimeoutMs, 2_000);
	assert.equal(contributions.mcpServers[0]?.toolTimeoutMs, 70_000);
	assert.equal(contributions.mcpServers[0]?.source, "plugin");
	assert.equal(contributions.mcpServers[0]?.required, true);
	assert.equal(contributions.mcpServers[0]?.defaultToolsApprovalMode, "prompt");
	assert.deepEqual(contributions.mcpServers[0]?.enabledTools, ["read"]);
	assert.deepEqual(contributions.mcpServers[0]?.sandbox, { network: "disabled" });
	const registry = await SkillRegistry.discover({ builtinRoot: join(root, "empty"), userRoot: join(root, "empty"), pluginSkills: contributions.skills });
	assert.deepEqual(registry.list().map((skill) => skill.name), ["demo@one:review", "demo@two:review"]);
	assert.equal(registry.list()[0]?.sourceKind, "repo");
	assert.deepEqual((await discoverPlugins({ homeDir, workspaceRoot, includeRepository: false })).selected, []);
});

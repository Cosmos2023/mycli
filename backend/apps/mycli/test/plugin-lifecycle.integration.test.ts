import { createRunExecutionSnapshot } from "@mycli/runtime";
import { captureChildIntegrationAuthority, inheritedIntegrationRegistrations } from "../src/node-runtime/child-integration-authority.ts";
import { createRuntimeSubagentServices } from "../src/node-runtime/runtime-subagent-services.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { McpClient, McpRequiredServerError, PluginPackageManager, pluginMcpServerId } from "@mycli/integrations";
import { builtinToolManifest } from "@mycli/tools";
import { createRuntimeIntegrationComposition, type CreateRuntimeIntegrationCompositionOptions, type RuntimeIntegrationComposition } from "../src/node-runtime/integration-composition.ts";

const signal = new AbortController().signal;

test("live plugin changes replace catalogs and connections only after all run owners finish", async (t) => {
	const f = await fixture(t);
	assert.equal(f.tools().length, 0);
	await f.install();
	await f.composition.prepareRun("root", signal);
	assert.equal(f.tools().length, 1, "new tools must be discovered before run preparation completes");
	assert.equal(f.clients.size, 1);
	const old = f.tools()[0]!;
	const oldSkill = f.composition.skillCatalog;
	assert.match(oldSkill, /reviewer:review/u);
	assert.equal(f.composition.hooks.length, 1);
	const plugin = f.composition.resources.find((row) => row.type === "plugin");
	const mcp = f.composition.resources.find((row) => row.type === "mcp");
	assert.equal(plugin?.command, "/plugins");
	assert.equal(mcp?.command, "/mcp");
	assert.match(String(plugin?.inspection_detail), /reviewer\/docs/u);
	assert.match(String(mcp?.inspection_detail), /mycli mcp login reviewer\/docs/u);
	assert.equal(mcp?.status, "ready");
	const version = f.composition.version;
	await f.update("2.0.0");
	await f.composition.refreshConfiguration();
	await f.composition.prepareRun("child", signal);
	f.composition.finishRun("root");
	await f.composition.refreshConfiguration();
	assert.equal(f.composition.version, version);
	assert.equal(f.closed.size, 0);
	assert.equal(f.composition.skillCatalog, oldSkill);
	assert.equal((await old.adapter.execute({}, f.execution)).modelOutput, "1.0.0");
	f.composition.finishRun("child");
	await Promise.all([f.composition.refreshConfiguration(), f.composition.refreshConfiguration(), f.composition.refreshConfiguration()]);
	assert.equal(f.clients.size, 2, "concurrent refresh callers must publish one replacement");
	assert.equal(f.closed.size, 1);
	assert.notEqual(f.composition.skillCatalog, oldSkill);
	assert.equal((await f.tools()[0]!.adapter.execute({}, f.execution)).modelOutput, "2.0.0");
	assert.equal((await old.adapter.execute({}, f.execution)).success, false, "retired adapters cannot reconnect");
	assert.notEqual(f.tools()[0]!.approvalScope?.fingerprint, old.approvalScope?.fingerprint);

	await f.composition.prepareRun("waiting-for-approval", signal);
	await f.packages.execute({ action: "disable", pluginId: "reviewer" }, signal);
	await f.composition.refreshConfiguration();
	assert.equal(f.tools().length, 1);
	f.composition.finishRun("waiting-for-approval");
	await f.composition.prepareRun("next", signal);
	assert.equal(f.tools().length, 0);
	assert.doesNotMatch(f.composition.skillCatalog, /reviewer:review/u);
	assert.equal(f.composition.hooks.length, 0);
	assert.equal(f.composition.resources.find((row) => row.type === "plugin")?.status, "disabled");
	f.composition.finishRun("next");
	await f.packages.execute({ action: "enable", pluginId: "reviewer" }, signal);
	await f.composition.refreshConfiguration();
	assert.equal(f.tools().length, 1);
	await f.packages.execute({ action: "remove", pluginId: "reviewer" }, signal);
	await f.composition.refreshConfiguration();
	assert.equal(f.tools().length, 0);
	assert.equal(f.composition.resources.some((row) => row.type === "plugin"), false);
	assert.equal(f.closed.size, f.clients.size);
});

test("failed refresh retains prior content and cancelled preparation does not leak a run owner", async (t) => {
	const f = await fixture(t);
	await f.install();
	await f.composition.refreshConfiguration();
	const old = f.tools()[0]!;
	const version = f.composition.version;
	await f.update("2.0.0", true);
	await assert.rejects(f.composition.prepareRun("failed", signal), McpRequiredServerError);
	assert.equal(f.composition.version, version);
	assert.equal((await old.adapter.execute({}, f.execution)).modelOutput, "1.0.0");
	await f.update("3.0.0");
	const discovery = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	f.blockDiscovery(async () => { started.resolve(); await discovery.promise; });
	const controller = new AbortController();
	const first = f.composition.prepareRun("cancelled", controller.signal);
	const rejected = assert.rejects(first, { name: "AbortError" });
	await started.promise;
	const second = f.composition.prepareRun("current", signal);
	controller.abort();
	discovery.resolve();
	await rejected;
	await second;
	assert.equal((await f.tools()[0]!.adapter.execute({}, f.execution)).modelOutput, "3.0.0");
	f.composition.finishRun("current");
	await f.packages.execute({ action: "remove", pluginId: "reviewer" }, signal);
	await f.composition.refreshConfiguration();
	assert.equal(f.tools().length, 0, "neither failed nor cancelled preparation can keep content leased");
});

test("shutdown cancels replacement discovery and prevents late publication", { timeout: 5_000 }, async (t) => {
	const f = await fixture(t);
	await f.install();
	await f.composition.refreshConfiguration();
	const version = f.composition.version;
	await f.update("2.0.0");
	const started = Promise.withResolvers<void>();
	f.blockDiscovery((activeSignal) => new Promise<void>((_resolve, reject) => {
		activeSignal.addEventListener("abort", () => reject(activeSignal.reason), { once: true });
		started.resolve();
	}));
	const pending = assert.rejects(f.composition.prepareRun("new", signal));
	await started.promise;
	await f.composition.close();
	await pending;
	assert.equal(f.composition.version, version);
	assert.equal(f.closed.size, f.clients.size);
	await assert.rejects(f.composition.refreshConfiguration(), /integration_composition_closed/u);
	await assert.rejects(f.composition.prepareRun("new", signal), /integration_composition_closed/u);
});

test("a waiting session pins only its own MCP, skill and hook content", async (t) => {
	const f = await fixture(t);
	const b = await f.createComposition({ parentSessionId: "b" });
	await f.install();
	await f.composition.prepareRun("approval", signal);
	await b.refreshConfiguration();
	const aTool = f.tools()[0]!;
	const oldB = b.registrations.find((tool) => tool.source === "mcp")!;
	assert.notEqual(aTool.adapter, oldB.adapter, "sessions own separate clients");
	const oldSkill = f.composition.skillCatalog;
	const oldHooks = f.composition.hooks;
	await f.update("2.0.0");
	await b.prepareRun("new-turn", signal);
	await f.composition.refreshConfiguration();
	assert.equal((await aTool.adapter.execute({}, f.execution)).modelOutput, "1.0.0");
	assert.equal((await b.registrations.find((tool) => tool.source === "mcp")!.adapter.execute({}, f.execution)).modelOutput, "2.0.0");
	assert.equal(f.composition.skillCatalog, oldSkill);
	assert.equal(f.composition.hooks, oldHooks);
	assert.notEqual(b.skillCatalog, oldSkill);
	assert.notEqual(b.hooks, oldHooks);
	const serverId = pluginMcpServerId("reviewer", "docs");
	assert.equal((await f.composition.mcpResourceService.readResource(serverId, "docs:version", signal))[0]?.text, "1.0.0");
	assert.equal((await b.mcpResourceService.readResource(serverId, "docs:version", signal))[0]?.text, "2.0.0");
	assert.match(String(b.resources.find((row) => row.type === "plugin")?.inspection_detail), /2\.0\.0/u);
	assert.match(String(f.composition.resources.find((row) => row.type === "plugin")?.inspection_detail), /1\.0\.0/u);
	await b.close();
	assert.equal(f.supervisorClosures(), 0, "session cleanup must not close shared Agent controls");
	assert.equal((await aTool.adapter.execute({}, f.execution)).success, true, "closing B leaves A usable");
	f.composition.finishRun("approval");
	await f.composition.prepareRun("next-turn", signal);
	assert.equal((await f.tools()[0]!.adapter.execute({}, f.execution)).modelOutput, "2.0.0");
});

test("child clients retain parent configuration and reject changed tool authority on reload", async (t) => {
	const f = await fixture(t);
	await f.install();
	await f.composition.prepareRun("parent", signal);
	const definitions = f.composition.registrations.map((registration) => registration.definition);
	const snapshot = createRunExecutionSnapshot({ turnId: "parent", collaborationMode: "default",
		toolCatalog: { catalogVersion: f.composition.version, directTools: definitions } });
	const authority = captureChildIntegrationAuthority(f.composition, snapshot, definitions.map((tool) => tool.name))!;
	const child = await f.createComposition({ configuration: f.composition.configuration, pinConfiguration: true });
	const childTool = inheritedIntegrationRegistrations(child, authority).find((tool) => tool.source === "mcp")!;
	assert.ok(childTool);
	const changedSchema = { ...child, registrations: [{ ...childTool,
		definition: { ...childTool.definition, inputSchema: { type: "object", required: ["extra"] } } }] };
	assert.deepEqual(inheritedIntegrationRegistrations(changedSchema, authority), []);
	assert.ok(childTool.approvalScope);
	const changedScope = { ...child, registrations: [{ ...childTool,
		approvalScope: { ...childTool.approvalScope, fingerprint: "c".repeat(64) } }] };
	assert.deepEqual(inheritedIntegrationRegistrations(changedScope, authority), []);
	f.composition.finishRun("parent");
	await f.update("2.0.0");
	await f.composition.refreshConfiguration();
	await child.prepareRun("child-turn", signal);
	assert.equal((await childTool.adapter.execute({}, f.execution)).modelOutput, "1.0.0");
	assert.equal(inheritedIntegrationRegistrations(f.composition, authority).some((tool) => tool.source === "mcp" || tool.source === "skill"), false);
	assert.equal(inheritedIntegrationRegistrations(child, undefined).some((tool) => tool.source === "mcp" || tool.source === "skill"), false);
	assert.equal(captureChildIntegrationAuthority(child, undefined, definitions.map((tool) => tool.name)), undefined);
	await child.close();
	assert.equal((await f.tools()[0]!.adapter.execute({}, f.execution)).modelOutput, "2.0.0");
});

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-lifecycle-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const source = join(root, "source");
	await mkdir(homeDir);
	await mkdir(workspaceRoot);
	await mkdir(join(source, ".codex-plugin"), { recursive: true });
	await mkdir(join(source, "skills/review"), { recursive: true });
	let version = "1.0.0";
	let beforeDiscovery: (activeSignal: AbortSignal) => Promise<void> = async () => undefined;
	const clients = new Map<McpClient, string>();
	const closed = new Set<McpClient>();
	// Protocol behavior is deterministic here; the gateway journey covers the real HTTP client.
	t.mock.method(McpClient.prototype, "listTools", async function(this: McpClient, activeSignal: AbortSignal) {
		clients.set(this, clients.get(this) ?? this.config.url!.split("/").at(-1)!);
		await beforeDiscovery(activeSignal);
		activeSignal.throwIfAborted();
		return [{ serverId: pluginMcpServerId("reviewer", "docs"), name: "read", description: "Read docs", inputSchema: { type: "object" }, supportsParallelToolCalls: true }];
	});
	t.mock.method(McpClient.prototype, "listResources", async () => []);
	t.mock.method(McpClient.prototype, "readResource", async function(this: McpClient): ReturnType<McpClient["readResource"]> {
		if (closed.has(this)) throw new Error("mcp_client_closed");
		return [{ serverId: this.config.id, uri: "docs:version", text: this.config.url!.split("/").at(-1)! }];
	});
	t.mock.method(McpClient.prototype, "callTool", async function(this: McpClient) {
		if (closed.has(this)) throw new Error("mcp_client_closed");
		return { content: [{ type: "text", text: clients.get(this)! }], isError: false };
	});
	t.mock.method(McpClient.prototype, "close", async function(this: McpClient) { closed.add(this); });
	const packages = new PluginPackageManager({ homeDir, workspaceRoot });
	const writeBundle = async (invalid = false): Promise<void> => {
		await writeFile(join(source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "reviewer", version,
			mcpServers: { mcpServers: { docs: invalid ? { command: "never-run", required: true, env: false }
				: { url: `http://127.0.0.1:1/mcp/${version}` } } },
			hooks: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "exit 0" }] }] } },
		}));
		await writeFile(join(source, "skills/review/SKILL.md"), `---\nname: review\ndescription: Review version ${version}\n---\nReview ${version}.`);
	};
	await writeBundle();
	let supervisorClosures = 0;
	const compositionOptions: CreateRuntimeIntegrationCompositionOptions = {
		builtinManifest: builtinToolManifest(), workspaceRoot, homeDir, env: {}, projectConfigurationEnabled: false,
		parentSessionId: "plugin-test", parentTurnId: () => "turn", parentTools: () => [],
		createSubagentSupervisor: () => ({
			spawn: async () => assert.fail("no agents should start"), output: () => assert.fail("no agent output"),
			send: async () => assert.fail("no agent input"), interrupt: async () => false, waitFor: async () => undefined,
			unload: async () => false, list: () => [], recoverLegacyAbandoned: () => 0, close: async () => { supervisorClosures += 1; },
		}),
		resolveSubagentSpawnContext: () => assert.fail("no agents should spawn"),
	};
	const controls = createRuntimeSubagentServices({
		createSupervisor: compositionOptions.createSubagentSupervisor,
		parentSessionId: "plugin-test", parentTurnId: () => "turn", parentTools: () => [],
		resolveSpawnContext: compositionOptions.resolveSubagentSpawnContext,
	});
	t.after(() => controls.close());
	const createComposition = async (overrides: Partial<CreateRuntimeIntegrationCompositionOptions> = {}): Promise<RuntimeIntegrationComposition> => {
		const result = await createRuntimeIntegrationComposition({ ...compositionOptions, subagentServices: controls, ...overrides });
		t.after(() => result.close());
		return result;
	};
	const composition = await createComposition();
	return { composition, createComposition, packages, clients, closed,
		supervisorClosures: () => supervisorClosures,
		tools: () => composition.registrations.filter((tool) => tool.source === "mcp"),
		execution: { signal, callId: "read", ownerSessionId: "session", publishLifecycle: () => undefined },
		blockDiscovery: (handler: typeof beforeDiscovery): void => { beforeDiscovery = handler; },
		install: async (): Promise<void> => { assert.equal((await packages.execute({ action: "add", source }, signal)).ok, true); },
		update: async (next: string, invalid = false): Promise<void> => {
			version = next; await writeBundle(invalid);
			assert.equal((await packages.execute({ action: "update", pluginId: "reviewer" }, signal)).ok, true);
		},
	};
}

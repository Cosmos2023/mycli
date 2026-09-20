import assert from "node:assert/strict";
import { removeFixtureDirectoryAfterTests } from "../../../packages/storage/test/fixtures/directory-cleanup.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { WorkspaceTrustStore } from "@mycli/config";
import { type McpManagerDiscovery, type McpToolCallResult } from "@mycli/integrations";
import { createMcpToolRegistration, McpManager } from "@mycli/integrations/mcp";
import { builtinToolManifest } from "@mycli/tools";
import { createRuntimeIntegrationComposition } from "../src/node-runtime/integration-composition.ts";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import { responsesTextEvents, responsesToolBatchEvents, responsesToolEvents } from "./support/responses-sse.ts";

test("MCP catalog publishes connection results and fences refreshes after workspace reload", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-catalog-"));
	removeFixtureDirectoryAfterTests(t, root);
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	await mkdir(join(workspaceRoot, ".mycli"), { recursive: true });
	await mkdir(homeDir);
	await writeFile(join(workspaceRoot, ".mycli/mcp_servers.toml"), [
		'[servers.docs]', 'command = "never-spawn"',
		'[servers.broken]', 'command = "never-spawn"',
		'[servers.off]', 'command = "never-spawn"', 'enabled = false',
	].join("\n"));
	const refreshes: { complete: (discovery: McpManagerDiscovery) => void }[] = [];
	t.mock.method(McpManager.prototype, "loadCached", async () => undefined);
	t.mock.method(McpManager.prototype, "refresh", () => new Promise<McpManagerDiscovery>((resolve) => {
		refreshes.push({ complete: resolve });
	}));
	const composition = await createRuntimeIntegrationComposition({
		builtinManifest: builtinToolManifest(), workspaceRoot, homeDir, env: {},
		parentSessionId: "catalog", parentTurnId: () => "turn", parentTools: () => [],
		createSubagentSupervisor: () => ({
			spawn: async () => assert.fail("inspection must not spawn an agent"), output: () => assert.fail("no agent output expected"),
			send: async () => assert.fail("inspection must not send input"), interrupt: async () => false,
			waitFor: async () => undefined, unload: async () => false, list: () => [], recoverLegacyAbandoned: () => 0,
			close: async () => undefined,
		}),
		resolveSubagentSpawnContext: () => assert.fail("inspection must not spawn an agent"),
	});
	t.after(() => composition.close());
	assert.deepEqual(composition.resources.filter((row) => row.type === "mcp").map((row) => [row.name, row.status]), [
		["broken", "loading"], ["docs", "loading"], ["off", "disabled"],
	]);
	const discovery: McpManagerDiscovery = { registrations: [], resources: [], servers: [
		{ serverId: "docs", transport: "stdio", enabled: true, status: "ok", toolCount: 1, resourceCount: 0, timeoutMs: 30_000 },
		{ serverId: "broken", transport: "stdio", enabled: true, status: "failed", toolCount: 0, resourceCount: 0, timeoutMs: 30_000,
			failureCategory: "connection_closed" },
		{ serverId: "off", transport: "stdio", enabled: false, status: "disabled", toolCount: 0, resourceCount: 0, timeoutMs: 30_000 },
	] };
	refreshes[0]!.complete(discovery);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(composition.resources.filter((row) => row.type === "mcp").map((row) => [row.name, row.status]), [
		["broken", "failed"], ["docs", "ready"], ["off", "disabled"],
	]);
	assert.equal(composition.resources.some((row) => row.type === "plugin"), false);
	await composition.reloadProjectConfiguration({ workspaceRoot, enabled: false });
	await composition.reloadProjectConfiguration({ workspaceRoot, enabled: true });
	// Disabling the project configuration removes every MCP server, so that
	// reload discovers nothing and never starts a manager refresh.
	assert.equal(refreshes.length, 2);
	const stale = refreshes.at(-1)!;
	await composition.reloadProjectConfiguration({ workspaceRoot, enabled: false });
	const version = composition.version;
	stale.complete(discovery);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(composition.version, version);
	assert.equal(composition.resources.some((row) => row.type === "mcp"), false);
	await composition.close();
	for (const refresh of refreshes) refresh.complete(discovery);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(composition.version, version);
});

for (const catalogSize of [3, 100]) {
test(`${catalogSize} MCP tools preserve cross-turn exposure and synchronized approvals`, {
	timeout: 30_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-approval-"));
	const cleanup: { backend?: () => Promise<void>; provider?: () => Promise<void> } = {};
	t.after(async () => {
		try {
			await cleanup.backend?.();
		} finally {
			await cleanup.provider?.();
			await rm(root, { recursive: true, force: true });
		}
	});
	const fixtureHome = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(join(fixtureHome, ".mycli"), { recursive: true });
	await mkdir(workspace);
	await new WorkspaceTrustStore({ homeDir: fixtureHome }).save(workspace, "trusted");
	await writeFile(join(fixtureHome, ".mycli/mcp_servers.toml"), [
		'[servers.date]', 'transport = "streamable_http"', 'url = "http://127.0.0.1:1/date"',
		'[servers.web]', 'transport = "streamable_http"', 'url = "http://127.0.0.1:1/web"',
	].join("\n"));
	const executed: string[] = [];
	const registrations = [
		{ serverId: "date", name: "today", properties: {} },
		{ serverId: "web", name: "search", properties: { query: { type: "string" } } },
		{ serverId: "web", name: "fetch", properties: { url: { type: "string", format: "uri" } } },
	].map((tool) => createMcpToolRegistration({
		callTool: async (name): Promise<McpToolCallResult> => {
			executed.push(name);
			return { content: [{ type: "text", text: `${name} succeeded` }], isError: false };
		},
	}, {
		...tool, description: "MCP fixture", supportsParallelToolCalls: true,
		inputSchema: { type: "object", properties: tool.properties, required: Object.keys(tool.properties) },
	}));
	for (let index = 3; index < catalogSize; index += 1) {
		registrations.push(createMcpToolRegistration({ callTool: async () => { throw new Error("auxiliary tool must not run"); } }, {
			serverId: "web", name: `extra${index}`, description: "Auxiliary tool", inputSchema: { type: "object" }, supportsParallelToolCalls: true,
		}));
	}
	const refresh = Promise.withResolvers<McpManagerDiscovery>();
	t.mock.method(McpManager.prototype, "loadCached", async () => undefined);
	t.mock.method(McpManager.prototype, "refresh", () => refresh.promise);
	let providerSteps = 0;
	const requestedTools: string[][] = [];
	const requestedDefinitions: unknown[][] = [];
	const provider = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
		request.on("end", () => {
			const payload = JSON.parse(body) as { tools?: { name?: string }[] };
			if (!payload.tools?.length) {
				const events = responsesTextEvents("MCP fixture summary: continue checking date and weather.", `summary-${providerSteps}`);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
				return;
			}
			providerSteps += 1;
			requestedDefinitions.push(payload.tools ?? []);
			requestedTools.push((payload.tools ?? []).flatMap((tool) => tool.name ? [tool.name] : []));
			const step = providerSteps - (catalogSize >= 100 ? 1 : 0);
			const events = catalogSize >= 100 && providerSteps === 1
				? responsesToolEvents("find", "tool_search", { query: "fixture", limit: 8 })
				: step % 2 === 1 ? responsesToolBatchEvents([
					{ callId: `date-${providerSteps}`, name: "mcp_date_today", argumentsValue: {} },
					{ callId: `search-${providerSteps}`, name: "mcp_web_search", argumentsValue: { query: "weather" } },
					{ callId: `fetch-${providerSteps}`, name: "mcp_web_fetch", argumentsValue: { url: "https://example.com/weather" } },
				], `mcp-calls-${providerSteps}`) : responsesTextEvents("MCP completed.", `final-${providerSteps}`);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
		});
	});
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	cleanup.provider = async (): Promise<void> => {
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
	};
	const address = provider.address();
	assert.ok(address && typeof address === "object");
	const backend = await startTestNodeBackend({
		cwd: workspace, args: ["--session", "mcp-approval", "--model", "gpt-test"],
		env: {
			...process.env, HOME: fixtureHome, USERPROFILE: fixtureHome,
			MYCLI_API_KEY: "fixture-key", MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false",
			MYCLI_REQUEST_MAX_RETRIES: "0", MYCLI_STREAM_MAX_RETRIES: "0", MYCLI_CACHE_RETENTION: "none",
			MYCLI_MEMORY_ENABLED: "false", MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		},
	});
	const send = (id: string, method: string, params: Readonly<Record<string, unknown>>): void => {
		backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	};
	cleanup.backend = async (): Promise<void> => {
		send("shutdown", "shutdown", {});
		await backend.completion;
	};
	const messages: CatalogTestMessage[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(JSON.parse(line) as CatalogTestMessage);
	});
	await waitForCatalogState(() => messages.find((message) => message.method === "runtime.ready"));
	refresh.resolve({ registrations, resources: [], servers: ["date", "web"].map((serverId) => ({
		serverId, transport: "streamable_http", enabled: true, status: "ok",
		toolCount: serverId === "date" ? 1 : catalogSize - 1, resourceCount: 0, timeoutMs: 30_000,
	})) });
	await waitForCatalogState(() => messages.find((message) => message.method === "extension.updated"));
	send("manifest", "extension.manifest", {});
	const manifest = await waitForCatalogState(() => messages.find((message) => message.id === "manifest"));
	assert.equal(manifest.result?.capabilities?.tool_names?.includes("mcp_web_fetch"), true);
	for (const turn of [1, 2]) {
		const messageOffset = messages.length;
		const stepOffset = requestedTools.length;
		send(`submit-${turn}`, "turn.submit", {
			message: "Check the date and weather, and fetch the weather page.",
			client_turn_id: `mcp-turn-${turn}`, client_user_message_id: `mcp-user-${turn}`,
		});
		const approvals = (): CatalogTestMessage[] => messages.slice(messageOffset).filter((message) => message.method === "approval.request");
		const final = (): CatalogTestMessage | undefined => messages.slice(messageOffset).find((message) => (
			message.method === "message.complete" && message.params?.final === true
		));
		for (let index = 0; index < 3; index += 1) {
			await waitForCatalogState(() => {
				const failed = messages.slice(messageOffset).find((message) => message.method === "turn.failed");
				assert.equal(failed, undefined, `turn failed: ${String(failed?.params?.code)}`);
				return approvals()[index] ?? final();
			});
			const approval = approvals()[index];
			assert.ok(approval, "registered tools must reach approval instead of being denied by discovery state");
			if (index === 0) assert.equal(executed.length, (turn - 1) * 3);
			assert.ok(typeof approval.params?.decision_id === "string");
			send(`approve-${turn}-${index}`, "approval.respond", {
				decision_id: approval.params.decision_id, choice: "approve_once",
			});
		}
		const completed = await waitForCatalogState(final);
		await waitForCatalogState(() => messages.slice(messages.indexOf(completed) + 1).find((message) =>
			message.method === "status.changed" && message.params?.turn_running === false));
		const initialTools = requestedTools[stepOffset]!;
		assert.equal(initialTools.includes("mcp_web_fetch"), catalogSize < 100 || turn === 2);
		assert.equal(initialTools.includes("tool_search"), catalogSize >= 100);
		if (turn === 2) assert.deepEqual(requestedDefinitions[stepOffset], requestedDefinitions[stepOffset - 1]);
	}
	assert.deepEqual(executed.toSorted(), ["fetch", "fetch", "search", "search", "today", "today"]);
	assert.equal(messages.some((message) => message.method === "tool.complete" && message.params?.success === false), false);
	assert.equal(providerSteps, catalogSize >= 100 ? 5 : 4);
});
}

interface CatalogTestMessage {
	readonly id?: string;
	readonly method?: string;
	readonly params?: Readonly<Record<string, unknown>>;
	readonly result?: { readonly capabilities?: { readonly tool_names?: readonly string[] } };
}

async function waitForCatalogState<Value>(read: () => Value | undefined): Promise<Value> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for MCP catalog test state");
}

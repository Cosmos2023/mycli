import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WorkspaceTrustStore } from "@mycli/config";
import { PluginPackageManager } from "@mycli/integrations";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import { responsesTextEvents, responsesToolEvents } from "./support/responses-sse.ts";

test("plugin MCP updates preserve a live approval, then refresh tools and approvals in the same backend", { timeout: 25_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-plugin-gateway-"));
	const homeDir = join(root, "home");
	const workspace = join(root, "repo");
	const source = join(root, "bundle");
	const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
	const calledVersions: string[] = [];
	const openedStreams: string[] = [];
	const closedStreams: string[] = [];
	const catalogs: { readonly name?: string; readonly description?: string }[][] = [];
	const messages: Message[] = [];
	const owned: { backend?: Awaited<ReturnType<typeof startTestNodeBackend>> } = {};
	const remote = createServer(async (request, response) => {
		try {
			const payload = request.method === "POST" ? await bodyJson(request) : undefined;
			if (request.url?.startsWith("/mcp/")) {
				const version = request.url.split("/").at(-1)!;
				const sessionId = request.headers["mcp-session-id"];
				let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
				if (!session && payload?.method === "initialize") {
					const server = new Server({ name: "plugin-docs", version }, { capabilities: { tools: {} } });
					const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
					server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "read", description: `Plugin version ${version}`,
						inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }));
					server.setRequestHandler(CallToolRequestSchema, async () => {
						calledVersions.push(version);
						return { content: [{ type: "text", text: `Read with plugin ${version}` }] };
					});
					await server.connect(transport);
					session = { server, transport };
					await transport.handleRequest(request, response, payload);
					sessions.set(transport.sessionId!, session);
					return;
				}
				if (!session) { response.writeHead(404).end(); return; }
				if (request.method === "GET") {
					openedStreams.push(version);
					response.once("close", () => closedStreams.push(version));
				}
				await session.transport.handleRequest(request, response, payload);
				return;
			}
			const tools = payload?.tools as { name?: string; description?: string }[] | undefined;
			if (!tools?.length) {
				response.writeHead(200, { "content-type": "text/event-stream" }).end(sse(responsesTextEvents("Plugin fixture summary", "summary")));
				return;
			}
			catalogs.push(tools);
			const step = catalogs.length;
			const name = tools.find((tool) => tool.description?.startsWith("Plugin version"))?.name;
			assert.ok(name, "a turn must capture the configured plugin tool");
			const events = step % 2 === 1 ? responsesToolEvents(`read-${step}`, name, {}) : responsesTextEvents("Read completed.", `final-${step}`);
			response.writeHead(200, { "content-type": "text/event-stream" }).end(sse(events));
		} catch { if (!response.headersSent) response.writeHead(500); response.end(); }
	});
	const send = (id: string, method: string, params: Readonly<Record<string, unknown>>): void => {
		owned.backend!.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	};
	t.after(async () => {
		try { if (owned.backend) { send("shutdown", "shutdown", {}); await owned.backend.completion; } }
		finally {
			await Promise.all([...sessions.values()].map((session) => session.server.close()));
			remote.closeAllConnections();
			await new Promise<void>((resolve) => remote.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});
	await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
	const address = remote.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	await mkdir(homeDir);
	await mkdir(workspace);
	await mkdir(join(source, ".codex-plugin"), { recursive: true });
	await new WorkspaceTrustStore({ homeDir }).save(workspace, "trusted");
	const writeBundle = (version: string): Promise<void> => writeFile(join(source, ".codex-plugin/plugin.json"), JSON.stringify({
		name: "docs", version, mcpServers: { mcpServers: { service: { url: `${url}/mcp/${version}`, required: true, default_tools_approval_mode: "prompt" } } },
	}));
	await writeBundle("1.0.0");
	const packages = new PluginPackageManager({ homeDir, workspaceRoot: workspace });
	const signal = new AbortController().signal;
	assert.equal((await packages.execute({ action: "add", source }, signal)).ok, true);
	owned.backend = await startTestNodeBackend({ cwd: workspace, args: ["--session", "plugin-lifecycle", "--model", "gpt-test"],
		env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, MYCLI_API_KEY: "fixture", MYCLI_BASE_URL: `${url}/v1`,
			MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false", MYCLI_REQUEST_MAX_RETRIES: "0",
			MYCLI_STREAM_MAX_RETRIES: "0", MYCLI_MEMORY_ENABLED: "false", MYCLI_AGENT_EXECUTION_ADAPTER: "worker" } });
	createInterface({ input: owned.backend.transport.input, crlfDelay: Infinity }).on("line", (line) => messages.push(JSON.parse(line) as Message));
	await until(() => messages.find((message) => message.method === "runtime.ready"));
	await until(() => openedStreams.includes("1.0.0") || undefined);
	for (const turn of [1, 2]) {
		const offset = messages.length;
		send(`submit-${turn}`, "turn.submit", { message: "Read docs using the plugin.", client_turn_id: `turn-${turn}`, client_user_message_id: `user-${turn}` });
		const approval = await until(() => {
			assert.equal(messages.slice(offset).find((message) => message.method === "turn.failed" || message.error), undefined);
			return messages.slice(offset).find((message) => message.method === "approval.request");
		});
		assert.equal(calledVersions.length, turn - 1);
		if (turn === 1) {
			await writeBundle("2.0.0");
			assert.equal((await packages.execute({ action: "update", pluginId: "docs" }, signal)).ok, true);
			send("during-approval", "resource.list", {});
			const rows = (await until(() => messages.find((message) => message.id === "during-approval"))).result?.resources;
			assert.equal(rows?.find((row) => row.type === "plugin")?.name, "docs");
			assert.equal(rows?.find((row) => row.type === "mcp")?.name, "docs/service");
			send("plugin-inspection", "command.run", { command: "/plugins", surface: "tui" });
			assert.match(JSON.stringify((await until(() => messages.find((message) => message.id === "plugin-inspection"))).result), /Version: 1\.0\.0/u);
			assert.equal(closedStreams.length, 0, "an update must not close a pending approval's client");
		}
		send(`approve-${turn}`, "approval.respond", { decision_id: approval.params!.decision_id, choice: turn === 1 ? "always_allow" : "approve_once" });
		const final = await until(() => messages.slice(offset).find((message) => message.method === "message.complete" && message.params?.final === true));
		await until(() => messages.slice(messages.indexOf(final) + 1).find((message) => message.method === "status.changed" && message.params?.turn_running === false));
		assert.deepEqual(catalogs[(turn - 1) * 2], catalogs[(turn - 1) * 2 + 1], "a continuation must retain the original catalog");
	}
	assert.deepEqual(calledVersions, ["1.0.0", "2.0.0"]);
	assert.match(JSON.stringify(catalogs[2]), /Plugin version 2\.0\.0/u);
	await until(() => closedStreams.includes("1.0.0") || undefined);
	assert.equal(messages.some((message) => message.method === "tool.complete" && message.params?.success === false), false);
	await packages.execute({ action: "remove", pluginId: "docs" }, signal);
	send("idle", "resource.list", {});
	const idle = await until(() => messages.find((message) => message.id === "idle"));
	assert.equal(idle.result?.resources?.some((row) => row.type === "plugin" || row.type === "mcp"), false);
	await until(() => closedStreams.includes("2.0.0") || undefined);
});

interface Message {
	readonly id?: string;
	readonly method?: string;
	readonly params?: Readonly<Record<string, unknown>>;
	readonly result?: { readonly resources?: readonly Readonly<Record<string, unknown>>[] };
	readonly error?: { readonly code: string };
}

function sse(events: readonly unknown[]): string { return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""); }

async function bodyJson(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Readonly<Record<string, unknown>>;
}

async function until<Value>(read: () => Value | undefined): Promise<Value> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("plugin lifecycle test timed out");
}

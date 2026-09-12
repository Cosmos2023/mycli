import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WorkspaceTrustStore } from "@mycli/config";
import { PluginPackageManager } from "@mycli/integrations";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import { responsesTextEvents, responsesToolEvents } from "./support/responses-sse.ts";

test("plugin MCP updates preserve a live approval, then refresh tools and approvals in the same backend", { timeout: 25_000 }, async (t) => {
	const { send, messages, closedStreams, calledVersions, catalogs, packages, signal, writeBundle } = await gatewayFixture(t);
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

test("root refresh proceeds while its child waits on the original MCP approval", { timeout: 25_000 }, async (t) => {
	let rootSteps = 0;
	let childSteps = 0;
	const f = await gatewayFixture(t, (payload, name) => {
		if (JSON.stringify(payload).includes("You are a subagent operating under the parent agent's delegated authority.")) {
			childSteps += 1;
			return childSteps === 1 ? responsesToolEvents("child-read", name, {}) : responsesTextEvents("Child read completed.", "child-final");
		}
		rootSteps += 1;
		if (rootSteps === 1) return responsesToolEvents("spawn-reader", "spawn_agent", { task_name: "reader", message: "Read docs using the plugin." });
		return responsesTextEvents("Delegation started.", `root-${rootSteps}`);
	});
	f.send("start-parent", "turn.submit", { message: "Delegate the docs read.", client_turn_id: "parent", client_user_message_id: "parent-user" });
	const approval = await until(() => f.messages.find((message) => message.method === "approval.request"));
	assert.notEqual(approval.params?.session_id, "plugin-lifecycle");
	const final = await until(() => f.messages.find((message) => message.method === "message.complete" && message.params?.final === true));
	await until(() => f.messages.slice(f.messages.indexOf(final) + 1).find((message) => message.method === "status.changed" && message.params?.turn_running === false));
	await until(() => f.openedStreams.length === 2 || undefined);
	await f.writeBundle("2.0.0");
	assert.equal((await f.packages.execute({ action: "update", pluginId: "docs" }, f.signal)).ok, true);
	f.send("updated-root", "command.run", { command: "/plugins", surface: "tui" });
	const inspection = await until(() => f.messages.find((message) => message.id === "updated-root"));
	assert.match(JSON.stringify(inspection.result), /Version: 2\.0\.0/u);
	await until(() => f.closedStreams.length === 1 || undefined);
	assert.equal(f.calledVersions.length, 0, "refresh must not execute the pending child call");
	f.send("approve-child", "approval.respond", { session_id: approval.params!.session_id,
		generation: approval.params!.generation, decision_id: approval.params!.decision_id, choice: "approve_once" });
	assert.equal((await until(() => f.messages.find((message) => message.id === "approve-child"))).error, undefined);
	await until(() => f.calledVersions.length === 1 || undefined);
	assert.deepEqual(f.calledVersions, ["1.0.0"]);
	await until(() => f.messages.find((message) => message.method === "subagent.updated"
		&& (message.params?.subagent as { status?: string } | undefined)?.status === "completed"));
	assert.equal(f.messages.some((message) => message.error || (message.method === "tool.complete" && message.params?.success === false)), false);
});

test("gateway catalogs follow session selection and repeated resume reuses connections", { timeout: 25_000 }, async (t) => {
	const f = await gatewayFixture(t, () => responsesTextEvents("Session saved.", "saved"));
	f.send("seed-a", "turn.submit", { message: "Save this session.", client_turn_id: "seed", client_user_message_id: "seed-user" });
	const final = await until(() => f.messages.find((message) => message.method === "message.complete" && message.params?.final === true));
	await until(() => f.messages.slice(f.messages.indexOf(final) + 1).find((message) => message.method === "status.changed" && message.params?.turn_running === false));
	f.send("new-b", "session.new", {});
	const created = await until(() => f.messages.find((message) => message.id === "new-b"));
	assert.equal(created.error, undefined);
	const b = created.result?.session_id;
	assert.equal(typeof b, "string");
	await until(() => f.openedStreams.length === 2 || undefined);
	await f.writeBundle("2.0.0");
	assert.equal((await f.packages.execute({ action: "update", pluginId: "docs" }, f.signal)).ok, true);
	f.send("inspect-b", "command.run", { command: "/plugins", surface: "tui" });
	assert.match(JSON.stringify((await until(() => f.messages.find((message) => message.id === "inspect-b"))).result), /Version: 2\.0\.0/u);
	await until(() => f.closedStreams.length === 1 || undefined);
	for (const [index, sessionId] of ["plugin-lifecycle", b, "plugin-lifecycle", b].entries()) {
		f.send(`resume-${index}`, "session.resume", { session_id: sessionId });
		assert.equal((await until(() => f.messages.find((message) => message.id === `resume-${index}`))).error, undefined);
		f.send(`inspect-${index}`, "command.run", { command: "/plugins", surface: "tui" });
		assert.match(JSON.stringify((await until(() => f.messages.find((message) => message.id === `inspect-${index}`))).result), /Version: 2\.0\.0/u);
	}
	await until(() => f.openedStreams.length === 4 || undefined);
	assert.equal(f.closedStreams.length, 2);
});

async function gatewayFixture(t: TestContext, providerEvents?: (
	payload: Readonly<Record<string, unknown>>, name: string,
) => readonly unknown[]) {
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
			const events = providerEvents?.(payload!, name) ?? (step % 2 === 1 ? responsesToolEvents(`read-${step}`, name, {}) : responsesTextEvents("Read completed.", `final-${step}`));
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
	return { send, messages, openedStreams, closedStreams, calledVersions, catalogs, packages, signal, writeBundle };
}

interface Message {
	readonly id?: string;
	readonly method?: string;
	readonly params?: Readonly<Record<string, unknown>>;
	readonly result?: { readonly resources?: readonly Readonly<Record<string, unknown>>[]; readonly session_id?: string };
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

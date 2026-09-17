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
import { CallToolRequestSchema, ListToolsRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { WorkspaceTrustStore } from "@mycli/config";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import { responsesTextEvents, responsesToolBatchEvents } from "./support/responses-sse.ts";

test("MCP form and URL requests queue through the live gateway, preserve answers privately and cancel on interruption", { timeout: 25_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-elicitation-"));
	const homeDir = join(root, "home");
	const workspace = join(root, "repo");
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await mkdir(workspace);
	await new WorkspaceTrustStore({ homeDir }).save(workspace, "trusted");
	const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
	const results: ElicitResult[] = [];
	let sentCalls = false;
	let turn = 1;
	const remote = createServer(async (request, response) => {
		try {
			if (request.url === "/mcp") {
				const payload = request.method === "POST" ? await bodyJson(request) : undefined;
				const sessionId = request.headers["mcp-session-id"];
				let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
				if (!session && payload?.method === "initialize") {
					const server = new Server({ name: "forms", version: "1" }, { capabilities: { tools: {} } });
					const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
					server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["form", "url"].map((name) => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })) }));
					server.setRequestHandler(CallToolRequestSchema, async (input, extra) => {
						const result = await server.elicitInput(input.params.name === "form"
							? { message: "Enter an address", requestedSchema: { type: "object", properties: { address: { type: "string", format: "email" } }, required: ["address"] } }
							: { mode: "url", message: "Finish account setup", elicitationId: randomUUID(), url: "https://example.org/setup" },
						{ relatedRequestId: extra.requestId, signal: extra.signal });
						results.push(result);
						return { content: [{ type: "text", text: "Interaction resolved" }] };
					});
					await server.connect(transport);
					session = { server, transport };
					await transport.handleRequest(request, response, payload);
					sessions.set(transport.sessionId!, session);
					return;
				}
				if (!session) { response.writeHead(404).end(); return; }
				await session.transport.handleRequest(request, response, payload);
				return;
			}
			await bodyJson(request);
			const events = sentCalls ? responsesTextEvents("Finished.", `final-${turn}`) : responsesToolBatchEvents(
				["form", "url"].map((name) => ({ callId: `${name}-${turn}`, name: `mcp_forms_${name}`, argumentsValue: {} })), `calls-${turn}`);
			sentCalls = true;
			response.writeHead(200, { "content-type": "text/event-stream" }).end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
		} catch { if (!response.headersSent) response.writeHead(500); response.end(); }
	});
	await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
	const address = remote.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	await writeFile(join(homeDir, ".mycli/mcp_servers.toml"), `[servers.forms]\nurl = "${url}/mcp"\nrequired = true\ndefault_tools_approval_mode = "approve"\nsupports_parallel_tool_calls = true\ntool_timeout_sec = 0.25\n`);

	t.after(async () => {
		if (backend) { send("shutdown", "shutdown", {}); await backend.completion; }
		await Promise.all([...sessions.values()].map((session) => session.server.close()));
		remote.closeAllConnections();
		await new Promise<void>((resolve) => remote.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const messages: Message[] = [];
	const send = (id: string, method: string, params: Record<string, unknown>): void => {
		backend!.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	};
	const backend = await startTestNodeBackend({ cwd: workspace, args: ["--session", "elicitation", "--model", "gpt-test"],
		env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, MYCLI_API_KEY: "fixture", MYCLI_BASE_URL: `${url}/v1`,
			MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false", MYCLI_REQUEST_MAX_RETRIES: "0",
			MYCLI_STREAM_MAX_RETRIES: "0", MYCLI_MEMORY_ENABLED: "false" } });
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => messages.push(JSON.parse(line) as Message));
	await until(() => messages.find((message) => message.method === "runtime.ready"));
	send("submit", "turn.submit", { message: "Use both MCP tools", client_turn_id: "turn-1", client_user_message_id: "user-1" });
	const first = await until(() => messages.find((message) => message.method === "mcp.elicitation.request"));
	// User interaction can last longer than the configured service execution deadline.
	await new Promise<void>((resolve) => setTimeout(resolve, 350));
	assert.equal(messages.filter((message) => message.method === "mcp.elicitation.request").length, 1);
	const answer = (id: string, message: Message, valid = true): void => send(id, "mcp.elicitation.respond", {
		request_id: message.params!.request_id, session_id: message.params!.session_id, action: "accept",
		...(message.params!.mode === "form" ? { content: { address: valid ? "private-answer@example.org" : "invalid" } } : {}),
	});
	if (first.params!.mode === "form") {
		answer("invalid", first, false);
		assert.equal((await until(() => messages.find((message) => message.id === "invalid"))).error?.code, "invalid_params");
	}
	answer("answer-first", first);
	const second = await until(() => messages.find((message) => message.method === "mcp.elicitation.request" && message.params?.request_id !== first.params?.request_id));
	answer("answer-second", second);
	const final = await until(() => messages.find((message) => message.method === "message.complete" && message.params?.final === true));
	await until(() => messages.slice(messages.indexOf(final) + 1).find((message) =>
		message.method === "status.changed" && message.params?.turn_running === false));
	assert.equal(results.length, 2);
	assert.ok(results.some((result) => result.content?.address === "private-answer@example.org"));
	assert.doesNotMatch(JSON.stringify(messages), /private-answer@example.org/u);
	send("history", "transcript.load", { session_id: "elicitation" });
	const history = await until(() => messages.find((message) => message.id === "history"));
	assert.doesNotMatch(JSON.stringify(history), /private-answer@example.org/u);
	const offset = messages.length;
	turn = 2; sentCalls = false;
	send("submit-two", "turn.submit", { message: "Ask again", client_turn_id: "turn-2", client_user_message_id: "user-2" });
	const pending = await until(() => messages.slice(offset).find((message) => message.method === "mcp.elicitation.request"));
	send("interrupt", "turn.interrupt", { turn_id: pending.params!.turn_id });
	const interrupted = await until(() => messages.find((message) => message.id === "interrupt"));
	assert.equal(interrupted.error, undefined, JSON.stringify(interrupted));
	await until(() => messages.slice(offset).find((message) => message.method === "mcp.elicitation.respond" && message.params?.action === "cancel"));
	await until(() => messages.find((message) => message.id === "interrupt"));
	send("late-answer", "mcp.elicitation.respond", { request_id: pending.params!.request_id, session_id: "elicitation", action: "accept" });
	assert.equal((await until(() => messages.find((message) => message.id === "late-answer"))).error?.code, "clarification_not_pending");
});

interface Message { readonly id?: string; readonly method?: string; readonly params?: Record<string, unknown>; readonly error?: { readonly code: string }; readonly result?: Record<string, unknown> }
async function bodyJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
async function until<Value>(read: () => Value | undefined): Promise<Value> {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		const value = read(); if (value !== undefined) return value;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("MCP elicitation test timed out");
}

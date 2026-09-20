import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { WorkspaceTrustStore } from "@mycli/config";
import { IntegrationToolApprovalStore } from "@mycli/integrations";
import { McpManagementService } from "@mycli/integrations/mcp";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import { responsesTextEvents, responsesToolBatchEvents } from "./support/responses-sse.ts";
import { createRuntimeIntegrationComposition } from "../src/node-runtime/integration-composition.ts";
import { builtinToolManifest } from "@mycli/tools";

test("required MCP startup and malformed required configuration block runtime readiness", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-required-startup-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".mycli"));
	for (const command of [JSON.stringify(join(root, "missing-executable")), "42"]) {
		await writeFile(join(root, ".mycli/mcp_servers.toml"), `[servers.required]\nrequired = true\ncommand = ${command}\nstartup_timeout_sec = 1\n`);
		const stages: string[] = [];
		await assert.rejects(createRuntimeIntegrationComposition({ builtinManifest: builtinToolManifest(), homeDir: root, workspaceRoot: root, env: {},
			parentSessionId: "required", parentTurnId: () => "turn", parentTools: () => [],
			createSubagentSupervisor: () => assert.fail("required MCP failure must stop startup"),
			resolveSubagentSpawnContext: () => assert.fail("no child execution expected"), onStartupStage: (stage) => stages.push(stage),
		}), /Required MCP servers could not start: required/u);
		assert.equal(stages.includes("mcp_cache_ready"), false);
	}
});

for (const parallel of [false, true]) {
	test(`MCP ${parallel ? "parallel" : "serial"} approvals persist and revoke through the gateway, provider and HTTP adapter`, { timeout: 45_000 }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "mycli-mcp-policy-flow-"));
		const homeDir = join(root, "home");
		const workspace = join(root, "repo");
		await mkdir(join(homeDir, ".mycli"), { recursive: true });
		await mkdir(workspace);
		await new WorkspaceTrustStore({ homeDir }).save(workspace, "trusted");
		let calls = 0;
		let turn = 0;
		let sentCalls = false;
		let changedSchema = false;
		const remote = createServer(async (request, response) => {
			if (request.url === "/mcp" && request.method !== "POST") { response.writeHead(405).end(); return; }
			const body = await bodyJson(request);
			if (request.url === "/mcp") {
				if (body.id === undefined) { response.writeHead(202).end(); return; }
				let result: unknown;
				switch (body.method) {
					case "initialize": result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }; break;
					case "tools/list": result = { tools: ["read", "write"].map((name) => ({ name, description: "Fixture tool",
						inputSchema: { type: "object", properties: changedSchema ? { extra: { type: "string" } } : {} } })) }; break;
					case "tools/call": calls += 1; result = { content: [{ type: "text", text: "done" }] }; break;
					default: result = { resources: [] };
				}
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
				return;
			}
			const events = sentCalls ? responsesTextEvents("Finished.", `final-${turn}`) : responsesToolBatchEvents(
				["read", "write"].map((name) => ({ callId: `${name}-${turn}`, name: `mcp_docs_${name}`, argumentsValue: {} })), `batch-${turn}`);
			sentCalls = true;
			response.writeHead(200, { "content-type": "text/event-stream" }).end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
		});
		await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
		const address = remote.address();
		assert.ok(address && typeof address === "object");
		const url = `http://127.0.0.1:${address.port}`;
		const configPath = join(homeDir, ".mycli/mcp_servers.toml");
		const config = `[servers.docs]\nurl = "${url}/mcp"\nrequired = true\ndefault_tools_approval_mode = "prompt"\nsupports_parallel_tool_calls = ${parallel}\n`;
		await writeFile(configPath, config);
		let backend: Awaited<ReturnType<typeof startTestNodeBackend>> | undefined;
		let messages: Message[] = [];
		const send = (id: string, method: string, params: Readonly<Record<string, unknown>>): void => {
			backend!.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		};
		const close = async (): Promise<void> => {
			if (!backend) return;
			send("shutdown", "shutdown", {});
			await backend.completion;
			backend = undefined;
		};
		t.after(async () => {
			await close();
			remote.closeAllConnections();
			await new Promise<void>((resolve) => remote.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		});
		const open = async (): Promise<void> => {
			messages = [];
			backend = await startTestNodeBackend({ cwd: workspace, args: ["--session", "mcp-policy", "--model", "gpt-test"],
				env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, MYCLI_API_KEY: "fixture", MYCLI_BASE_URL: `${url}/v1`,
					MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false", MYCLI_REQUEST_MAX_RETRIES: "0",
					MYCLI_STREAM_MAX_RETRIES: "0", MYCLI_CACHE_RETENTION: "none", MYCLI_MEMORY_ENABLED: "false",
					MYCLI_MAX_PROMPT_TOKENS: "100000" } });
			createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => { messages.push(JSON.parse(line) as Message); });
			await until(() => messages.find((message) => message.method === "runtime.ready"));
		};
		const run = async (expected: Readonly<Record<string, string>>): Promise<void> => {
			turn += 1;
			sentCalls = false;
			const offset = messages.length;
			const approved = new Set<string>();
			send(`submit-${turn}`, "turn.submit", { message: "Use both fixture tools.", client_turn_id: `turn-${turn}`, client_user_message_id: `user-${turn}` });
			const final = await until(() => {
				const current = messages.slice(offset);
				assert.equal(current.find((message) => message.error), undefined, JSON.stringify(current));
				assert.equal(current.find((message) => message.method === "turn.failed"), undefined, JSON.stringify(current));
				for (const message of current.filter((item) => item.method === "approval.request")) {
					const name = String(message.params?.tool_name);
					if (approved.has(name)) continue;
					assert.ok(expected[name], `unexpected approval for ${name}`);
					assert.deepEqual((message.params?.options as { choice: string }[]).map((option) => option.choice), ["approve_once", "reject", "allow_session", "always_allow"]);
					approved.add(name);
					send(`approve-${turn}-${name}`, "approval.respond", { decision_id: message.params?.decision_id, choice: expected[name] });
				}
				return current.find((message) => message.method === "message.complete" && message.params?.final === true);
			});
			await until(() => messages.slice(messages.indexOf(final) + 1).find((message) =>
				message.method === "status.changed" && message.params?.turn_running === false));
			assert.deepEqual([...approved].sort(), Object.keys(expected).sort());
			assert.equal(calls, turn * 2);
		};
		await open();
		await run({ mcp_docs_read: "allow_session", mcp_docs_write: "always_allow" });
		await run({});
		const management = new McpManagementService({ homeDir, workspaceRoot: workspace, env: {}, createClient: () => assert.fail("approval management does not discover tools") });
		assert.deepEqual((await management.approvals()).approvals, [{ id: "mcp:docs:write" }]);
		assert.equal((await management.revoke("docs")).ok, true);
		await run({ mcp_docs_write: "always_allow" });
		await close();
		await open();
		await run({ mcp_docs_read: "allow_session" });
		await close();
		changedSchema = true;
		await writeFile(configPath, `${config}tool_timeout_sec = 80\n`);
		await open();
		await run({ mcp_docs_read: "approve_once", mcp_docs_write: "approve_once" });
		assert.equal((await new IntegrationToolApprovalStore(homeDir).load()).length, 1);
	});
}

interface Message {
	readonly method?: string;
	readonly params?: Readonly<Record<string, unknown>>;
	readonly error?: { readonly code: string };
}
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
	throw new Error("MCP policy test timed out");
}

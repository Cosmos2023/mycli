import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WorkspaceTrustStore } from "@mycli/config";
import { openRuntimeSessionStore } from "@mycli/storage";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import { writeResponsesText, writeResponsesTool } from "./support/responses-sse.ts";

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==";
type Json = Record<string, unknown>;

test("Worker turns deliver local and MCP images, resources, approvals, and durable resume", { timeout: 60_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-image-resource-turn-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(join(workspace, ".mycli"), { recursive: true });
	await writeFile(join(workspace, "image.png"), Buffer.from(IMAGE, "base64"));
	const fixture = fileURLToPath(new URL("../../../packages/integrations/test/fixtures/mcp-images-server.mjs", import.meta.url));
	await writeFile(join(workspace, ".mycli", "mcp_servers.toml"), [
		"[servers.local]", 'transport = "stdio"', `command = ${JSON.stringify(process.execPath)}`,
		`args = [${JSON.stringify(fixture)}]`, "timeout_seconds = 10",
	].join("\n"));
	await new WorkspaceTrustStore({ homeDir: home }).save(workspace, "trusted");
	const calls = [
		{ name: "list_mcp_resources", args: {} },
		{ name: "list_mcp_resource_templates", args: { server: "local" } },
		{ name: "read_mcp_resource", args: { server: "local", uri: "data:///notes/example" } },
		{ name: "read_mcp_resource", args: { server: "local", uri: "data:///readme" } },
		{ name: "read_mcp_resource", args: { server: "local", uri: "data:///image" } },
		{ name: "view_image", args: { path: "image.png", detail: "original" } },
		{ name: "mcp_local_inspect_image", args: {} },
	];
	const bodies: Json[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const index = bodies.push(JSON.parse(body) as Json) - 1;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const call = calls[index];
			if (call) writeResponsesTool(response, `call-${index}`, call.name, call.args, `resp-${index}`);
			else writeResponsesText(response, "Images and resources inspected.", `resp-${index}`);
			response.end("data: [DONE]\n\n");
		});
	});
	let backend: NodeBackend | undefined;
	t.after(async () => {
		await backend?.close();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const env = {
		...process.env, HOME: home, USERPROFILE: home,
		MYCLI_API_KEY: "fixture-key", MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_SUPPORTS_IMAGES: "true",
		MYCLI_THINKING_ENABLED: "false", MYCLI_REQUEST_MAX_RETRIES: "0", MYCLI_STREAM_MAX_RETRIES: "0",
		MYCLI_MEMORY_ENABLED: "false", MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
	};
	for (const turn of ["initial", "resumed"]) {
		backend = await startTestNodeBackend({ cwd: workspace, args: ["--session", "image-tools", "--model", "gpt-5.4"], env });
		const messages: Json[] = [];
		const active = backend;
		let approvalId: unknown;
		const lines = createInterface({ input: active.transport.input, crlfDelay: Infinity });
		lines.on("line", (line) => {
			const message = JSON.parse(line) as Json;
			messages.push(message);
			if (message.method === "approval.request") {
				const params = message.params as Json;
				approvalId = params.decision_id;
			}
			if (approvalId && message.method === "status.changed" && (message.params as Json).pending_decision === true
				&& (message.params as Json).turn_running === false) {
				send(active, "approve-fixture", "approval.respond", { decision_id: approvalId, choice: "approve_once" });
				approvalId = undefined;
			}
		});
		await waitFor(() => messages.some((message) => message.method === "runtime.ready"));
		send(active, `submit-${turn}`, "turn.submit", { message: turn === "initial" ? "Inspect local and MCP images and resources." : "Recall the inspected images.", client_turn_id: turn, client_user_message_id: turn });
		await waitFor(() => messages.some((message) => message.method === "turn.completed" || message.method === "turn.failed"));
		assert.equal(messages.some((message) => message.method === "turn.failed"), false, JSON.stringify(messages.filter((message) => message.method === "turn.failed")));
		assert.equal(JSON.stringify(messages).includes(IMAGE), false, "gateway display must not receive image data");
		send(active, `shutdown-${turn}`, "shutdown", {});
		assert.equal(await active.completion, 0);
		lines.close();
		backend = undefined;
		await rm(join(workspace, "image.png"), { force: true });
	}
	assert.equal(bodies.length, 9);
	assert.ok(JSON.stringify(bodies[1]).includes("data:///readme"));
	assert.ok(JSON.stringify(bodies[2]).includes("data:///notes/{name}"));
	assert.ok(JSON.stringify(bodies[3]).includes("Note example"));
	assert.ok(JSON.stringify(bodies[4]).includes("Resource text reached the model."));
	for (const body of [bodies[7], bodies[8]]) {
		const serialized = JSON.stringify(body);
		assert.equal(serialized.split(`data:image/png;base64,${IMAGE}`).length - 1, 3);
		assert.ok(serialized.includes('"detail":"original"'));
	}
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const results = store.loadConversationItems("image-tools").filter((item) => item.type === "tool_result");
		assert.equal(results.length, 7);
		assert.equal(results.every((result) => result.success), true);
		assert.equal(results.find((result) => result.toolName === "view_image")?.images?.[0]?.detail, "original");
		assert.deepEqual(results.filter((result) => result.images?.length).map((result) => result.toolName), ["read_mcp_resource", "view_image", "mcp_local_inspect_image"]);
	} finally { store.close(); }
});

function send(backend: NodeBackend, id: string, method: string, params: Json): void {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

async function waitFor(read: () => boolean): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for image/resource turn");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { WorkspaceTrustStore } from "@mycli/config";
import { openRuntimeSessionStore } from "@mycli/storage";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";
import { writeResponsesText, writeResponsesTool } from "./support/responses-sse.ts";
import { shellCommand } from "./support/shell-command.ts";

type Json = Record<string, unknown>;

test("Shell hides its legacy description and preserves a larger output budget across Worker execution and resume", { timeout: 60_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-output-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	await writeFile(join(workspace, "output.cjs"), 'process.stdout.write("output-start\\n" + "x".repeat(20000) + "\\noutput-end\\n");\n');
	await new WorkspaceTrustStore({ homeDir: home }).save(workspace, "trusted");
	const command = shellCommand(process.execPath, ["output.cjs"], process.env);
	const description = "Legacy command summary";
	const bodies: Json[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			bodies.push(JSON.parse(body) as Json);
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (bodies.length === 1) {
				writeResponsesTool(response, "call-shell-output", "Shell", {
					command, description, max_output_tokens: 1_500, yield_time_ms: 30_000,
				}, `response-${bodies.length}`);
			} else {
				writeResponsesText(response, "Shell output inspected.", `response-${bodies.length}`);
			}
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
		MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false",
		MYCLI_REQUEST_MAX_RETRIES: "0", MYCLI_STREAM_MAX_RETRIES: "0", MYCLI_CACHE_RETENTION: "none",
		MYCLI_MAX_PROMPT_TOKENS: "128000",
		MYCLI_MEMORY_ENABLED: "false", MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
	};
	for (const turn of ["initial", "resumed"]) {
		backend = await startTestNodeBackend({ cwd: workspace, args: ["--session", "shell-output", "--model", "gpt-test"], env });
		const active = backend;
		const messages: Json[] = [];
		const lines = createInterface({ input: active.transport.input, crlfDelay: Infinity });
		t.after(() => lines.close());
		lines.on("line", (line) => { messages.push(JSON.parse(line) as Json); });
		await waitFor(() => messages.some((message) => message.method === "runtime.ready"));
		send(active, `permissions-${turn}`, "permissions.update", { profile: "full-access" });
		await waitFor(() => messages.some((message) => message.id === `permissions-${turn}`));
		assert.ok(messages.find((message) => message.id === `permissions-${turn}`)?.result);
		send(active, `submit-${turn}`, "turn.submit", {
			message: turn === "initial" ? "Inspect the command output." : "Recall the command output.",
			client_turn_id: turn, client_user_message_id: turn,
		});
		await waitFor(() => messages.some((message) => message.method === "turn.completed" || message.method === "turn.failed"));
		assert.deepEqual(messages.filter((message) => message.method === "turn.failed" || message.method === "tool.failed"), []);
		send(active, `shutdown-${turn}`, "shutdown", {});
		assert.equal(await active.completion, 0);
		lines.close();
		backend = undefined;
	}
	assert.equal(bodies.length, 3);
	for (const body of bodies) {
		assert.ok(Array.isArray(body.tools));
		const shell = (body.tools as Json[]).find((tool) => tool.name === "Shell");
		assert.ok(shell);
		const parameters = shell.parameters as Json;
		assert.equal("description" in (parameters.properties as Json), false);
		assert.deepEqual(parameters.required, ["command"]);
	}
	const outputs = bodies.slice(1).map((body) => {
		assert.ok(Array.isArray(body.input));
		const result = (body.input as Json[]).find((item) => item.type === "function_call_output" && item.call_id === "call-shell-output");
		assert.ok(result && typeof result.output === "string");
		return result.output;
	});
	const currentOutput = outputs[0];
	assert.ok(currentOutput);
	assert.equal(currentOutput.length, 6_000);
	assert.match(currentOutput, /output-start/u);
	assert.match(currentOutput, /output-end\s*$/u);
	assert.equal(outputs[1], currentOutput);
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const items = store.loadConversationItems("shell-output");
		const results = items.filter((item) => item.type === "tool_result");
		assert.equal(results.length, 1);
		assert.equal(results[0]?.success, true);
		assert.equal(results[0]?.output, currentOutput);
		const call = items.flatMap((item) => item.type === "assistant_tool_calls" ? item.calls : [])
			.find((item) => item.callId === "call-shell-output");
		assert.ok(call);
		assert.deepEqual(JSON.parse(call.argumentsJson), {
			command, description, max_output_tokens: 1_500, yield_time_ms: 30_000,
		});
	} finally { store.close(); }
});

function send(backend: NodeBackend, id: string, method: string, params: Json): void {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

async function waitFor(read: () => boolean): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Shell output turn");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseGatewayResult, parseJsonRpcMessage } from "@mycli/contracts";
import { openRuntimeSessionStore } from "@mycli/storage";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";
import { startTestNodeBackend as startNodeBackend } from "./support/offline-update-fetch.ts";
import { responsesTextEvents, responsesToolBatchEvents, responsesToolEvents } from "./support/responses-sse.ts";
import { shellCommand } from "./support/shell-command.ts";

type JsonObject = Record<string, unknown>;

const ROOT = new URL("../../../../", import.meta.url);
const M6_SMOKE = new URL("scripts/smoke_node_m6_shell.mjs", ROOT);

test("Node backend runs a full-access PTY without approval or Python", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m6-shell-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const pythonMarker = join(root, "python-started");
	const sessionId = "m6-persistent-shell";
	await Promise.all([mkdir(home), mkdir(workspace)]);
	await writeFile(join(workspace, "wait-input.cjs"), [
		"process.stdin.setEncoding('utf8');",
		"process.stdin.once('data', (value) => {",
		"  process.stdout.write('stdin:' + value.trim() + '\\n', () => process.exit(0));",
		"});",
	].join("\n"), "utf8");
	const command = shellCommand(process.execPath, ["wait-input.cjs"], process.env);
	const requests: JsonObject[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			const body = JSON.parse(raw) as JsonObject;
			requests.push(body);
			if (requests.length === 1) {
				writeSse(response, responsesTool("call-shell", "Shell", {
					command,
					tty: true,
					yield_time_ms: 250,
				}));
				return;
			}
			if (requests.length === 2) {
				const shellId = shellIdFromProviderInput(body) ?? "00000000";
				writeSse(response, responsesTool("call-input", "WriteStdin", {
					session_id: shellId,
					chars: process.platform === "win32" ? "hello-m6\r\n" : "hello-m6\n",
					yield_time_ms: 3_000,
				}));
				return;
			}
			writeSse(response, responsesFinal("PTY completed."));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", sessionId, "--model", "gpt-test"],
		maxOutputTokens: 64,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_PYTHON: pythonMarker,
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_REQUEST_MAX_RETRIES: "0",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_CACHE_RETENTION: "none",
			MYCLI_MAX_PROMPT_TOKENS: "128000",
		},
	});
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as JsonObject);
	});
	let closed = false;
	const shutdown = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		send(backend, "shutdown", "shutdown", {});
		assert.equal(await backend.completion, 0);
	};
	t.after(async () => {
		await shutdown();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
		await rm(root, { recursive: true, force: true });
	});
	await waitFor(() => event(messages, "runtime.ready"));
	await request(backend, messages, "trust", "workspace.trust.set", { state: "trusted" });
	await request(backend, messages, "permission", "permissions.update", { profile: "full-access" });
	send(backend, "turn", "turn.submit", {
		message: "Run the requested interactive terminal command.",
		client_turn_id: "m6-shell-turn",
		client_user_message_id: "m6-shell-user",
	});
	const final = await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& isObject(message.params)
		&& message.params.final === true
	)), 8_000);
	assert.equal(events(messages, "approval.request").length, 0);
	assert.equal(isObject(final.params) ? final.params.text : undefined, "PTY completed.");
	assert.equal(requests.length, 3);
	assert.equal(requests.every((body) => body.max_output_tokens === 64), true);
	assert.equal(events(messages, "shell.started").length, 1);
	await waitFor(() => events(messages, "shell.completed").length === 1, 5_000);
	assert.equal(events(messages, "shell.completed").length, 1);
	assert.equal(events(messages, "tool.failed").length, 0);
	assert.equal(existsSync(pythonMarker), false);
	await shutdown();

	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		if (!("loadReadableTranscript" in store)) assert.fail("expected normalized session storage");
		const shellItems = store.loadReadableTranscript(sessionId).filter((item) => (
			item.tool_name === "Shell" && typeof item.metadata?.shell_id === "string"
		));
		assert.equal(shellItems.length, 1);
		const metadata = isObject(shellItems[0]?.metadata) ? shellItems[0].metadata : {};
		assert.equal(metadata.tty, true);
		assert.equal(metadata.terminal_state, "completed");
		assert.equal(
			metadata.transport,
			process.platform === "win32" ? "windows_conpty" : "unix_pty",
		);
		assert.match(String(shellItems[0]?.output), /stdin:hello-m6/u);
	} finally {
		store.close();
	}
});

test("parallel Shell approvals advance while the first invocation still waits for output", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-shell-approval-progress-"));
	const homeDir = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(homeDir), mkdir(workspace)]);
	await writeFile(join(workspace, "first.cjs"), [
		"const fs = require('node:fs');",
		"process.stdout.write('first-ready\\n');",
		"const timer = setInterval(() => {",
		"  if (!fs.existsSync('finish-first')) return;",
		"  clearInterval(timer);",
		"  process.stdout.write('first-finished\\n');",
		"}, 10);",
	].join("\n"));
	await writeFile(join(workspace, "second.cjs"), "require('node:fs').writeFileSync('second-ran', 'done');\n");
	const bodies: JsonObject[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			bodies.push(JSON.parse(raw) as JsonObject);
			writeSse(response, bodies.length === 1 ? responsesToolBatchEvents(
				["first", "second"].map((name) => ({
					callId: `call-${name}`, name: "Shell",
					argumentsValue: {
						command: shellCommand(process.execPath, [`${name}.cjs`], process.env),
						yield_time_ms: 30_000, sandbox_permissions: "require_escalated",
						justification: `Run the ${name} command with the access required by the approval test.`,
					},
				})), "resp-two-shells",
			) : responsesFinal("Both commands completed."));
		});
	});
	let backend: NodeBackend | null = null;
	t.after(async () => {
		try { await backend?.close(); }
		finally {
			server.closeAllConnections();
			if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "approval-progress", "--model", "gpt-test"],
		env: {
			...process.env, HOME: homeDir, USERPROFILE: homeDir,
			MYCLI_API_KEY: "test-key", MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses", MYCLI_THINKING_ENABLED: "false",
			MYCLI_REQUEST_MAX_RETRIES: "0", MYCLI_STREAM_MAX_RETRIES: "0", MYCLI_CACHE_RETENTION: "none",
		},
	});
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as JsonObject);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	await request(backend, messages, "trust", "workspace.trust.set", { state: "trusted" });
	await request(backend, messages, "permission", "permissions.update", { profile: "workspace" });
	send(backend, "turn", "turn.submit", {
		message: "Launch both independent commands with separate approvals.",
		client_turn_id: "approval-progress-turn", client_user_message_id: "approval-progress-user",
	});
	const approvalFor = (callId: string): JsonObject | undefined => events(messages, "approval.request").find(
		(message) => isObject(message.params) && message.params.call_id === callId,
	);
	const shellEventFor = (method: string, callId: string): JsonObject | undefined => events(messages, method).find(
		(message) => isObject(message.params) && message.params.call_id === callId,
	);
	await waitFor(() => approvalFor("call-first"));
	await request(backend, messages, "approve-first", "approval.respond", { decision_id: "call-first", choice: "approve_once" });
	await waitFor(() => approvalFor("call-second"), 5_000);
	await waitFor(() => shellEventFor("shell.started", "call-first"));
	assert.ok(shellEventFor("shell.started", "call-first"), JSON.stringify(events(messages, "tool.failed")));
	assert.equal(shellEventFor("shell.completed", "call-first"), undefined);
	assert.equal(shellEventFor("shell.started", "call-second"), undefined);
	assert.equal(existsSync(join(workspace, "second-ran")), false);
	assert.equal(bodies.length, 1);
	assert.equal(shellEventFor("tool.complete", "call-first"), undefined);
	await waitFor(() => events(messages, "shell.output").find((message) => (
		isObject(message.params) && String(message.params.output_delta).includes("first-ready")
	)));

	await request(backend, messages, "approve-second", "approval.respond", { decision_id: "call-second", choice: "approve_once" });
	await waitFor(() => shellEventFor("shell.completed", "call-second"));
	assert.equal(existsSync(join(workspace, "second-ran")), true);
	assert.equal(shellEventFor("shell.completed", "call-first"), undefined);
	await waitFor(() => shellEventFor("tool.complete", "call-second"));
	assert.equal(shellEventFor("tool.complete", "call-first"), undefined);
	assert.equal(event(messages, "turn.completed"), undefined);
	assert.equal(bodies.length, 1);

	await writeFile(join(workspace, "finish-first"), "go");
	await waitFor(() => shellEventFor("shell.completed", "call-first"));
	await waitFor(() => event(messages, "turn.completed"));
	const outputs = Array.isArray(bodies[1]?.input) ? bodies[1].input.filter((item) => (
		isObject(item) && item.type === "function_call_output"
	)) : [];
	assert.deepEqual(outputs.map((item) => isObject(item) ? item.call_id : undefined), ["call-first", "call-second"]);
	const historyResponse = await request(backend, messages, "history", "transcript.load", { session_id: "approval-progress" });
	const history = parseGatewayResult("transcript.load", historyResponse.result);
	const records = history.items.filter((item) => item.tool_record?.call_id === "call-first");
	assert.equal(records.length, 1, JSON.stringify(records));
	assert.equal(records[0]?.tool_record?.shell?.terminal_state, "completed");
	assert.match(JSON.stringify(records[0]?.tool_record), /first-finished/u);

	assert.equal(events(messages, "shell.started").length, 2);
	assert.equal(events(messages, "approval.request").length, 2);
});

test("M6 live smoke exits 77 with one sanitized result when credentials are unavailable", async (t) => {
	const paths = await smokeTree(t, "unavailable");
	const result = await runSmoke(paths.workspace, {
		...process.env,
		HOME: paths.home,
		USERPROFILE: paths.home,
		MYCLI_API_KEY: "",
		MYCLI_AUTH_REF: "",
		MYCLI_BASE_URL: "",
	});
	assert.equal(result.code, 77);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleJsonLine(result.stdout), smokeResult("unavailable"));
});

test("M6 live smoke drives a full-access PTY without approval and reports only structural state", async (t) => {
	const paths = await smokeTree(t, "completed");
	const secret = "test-m6-live-secret";
	const requests: JsonObject[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			const body = JSON.parse(raw) as JsonObject;
			requests.push(body);
			if (requests.length === 1) {
				writeSse(response, responsesTool("smoke-shell", "Shell", {
					command: shellCommand(process.execPath, ["wait-input.cjs"], process.env),
					tty: true,
					yield_time_ms: 250,
				}));
				return;
			}
			if (requests.length === 2) {
				const shellId = shellIdFromProviderInput(body) ?? "00000000";
				writeSse(response, responsesTool("smoke-input", "WriteStdin", {
					session_id: shellId,
					chars: process.platform === "win32" ? "hello-m6-smoke\r\n" : "hello-m6-smoke\n",
					yield_time_ms: 3_000,
				}));
				return;
			}
			writeSse(response, responsesFinal("Smoke provider output."));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	}));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	const result = await runSmoke(paths.workspace, {
		...process.env,
		HOME: paths.home,
		USERPROFILE: paths.home,
		MYCLI_API_KEY: secret,
		MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai",
		MYCLI_MODEL: "gpt-test",
	});
	assert.equal(result.code, 0, JSON.stringify({
		summary: singleJsonLine(result.stdout),
		request_count: requests.length,
	}));
	assert.equal(result.stderr, "");
	assert.deepEqual(singleJsonLine(result.stdout), smokeResult("completed", true));
	assert.equal(requests.length, 3);
	assert.equal(requests.every((body) => body.max_output_tokens === 64), true);
	assert.doesNotMatch(
		result.stdout + result.stderr,
		new RegExp(`${secret}|127\\.0\\.0\\.1|wait-input|hello-m6-smoke|Smoke provider output`, "u"),
	);
});

function responsesTool(callId: string, name: string, argumentsValue: JsonObject): readonly JsonObject[] {
	return responsesToolEvents(callId, name, argumentsValue, `resp-${callId}`, {
		input_tokens: 4,
		output_tokens: 1,
		total_tokens: 5,
	});
}

function responsesFinal(text: string): readonly JsonObject[] {
	return responsesTextEvents(text, "resp-final", {
		input_tokens: 4,
		output_tokens: 1,
		total_tokens: 5,
	});
}

function writeSse(response: ServerResponse, items: readonly JsonObject[]): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const item of items) response.write(`data: ${JSON.stringify(item)}\n\n`);
	response.end("data: [DONE]\n\n");
}

function shellIdFromProviderInput(body: JsonObject): string | undefined {
	return /Process running with session ID ([0-9a-f]{8})/u.exec(JSON.stringify(body.input))?.[1];
}

function send(backend: NodeBackend, id: string, method: string, params: JsonObject): void {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

async function request(
	backend: NodeBackend,
	messages: readonly JsonObject[],
	id: string,
	method: string,
	params: JsonObject,
): Promise<JsonObject> {
	send(backend, id, method, params);
	const response = await waitFor(() => messages.find((message) => String(message.id) === id));
	assert.equal("error" in response, false, JSON.stringify(response.error));
	return response;
}

function event(messages: readonly JsonObject[], method: string): JsonObject | undefined {
	return messages.find((message) => message.method === method && !("id" in message));
}

function events(messages: readonly JsonObject[], method: string): JsonObject[] {
	return messages.filter((message) => message.method === method && !("id" in message));
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("timed out waiting for M6 persistent shell event");
}

async function smokeTree(
	t: TestContext,
	suffix: string,
): Promise<{ home: string; workspace: string }> {
	const root = await mkdtemp(join(tmpdir(), `mycli-node-m6-smoke-${suffix}-`));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));
	return { home, workspace };
}

function runSmoke(
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[fileURLToPath(M6_SMOKE), "--protocol", "responses"],
			{ cwd, env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function singleJsonLine(stdout: string): unknown {
	const lines = stdout.trim().split(/\r?\n/u);
	assert.equal(lines.length, 1);
	return JSON.parse(lines[0] ?? "") as unknown;
}

function smokeResult(status: string, completed = false): JsonObject {
	return {
		protocol: "responses",
		status,
		shell_started: completed ? 1 : 0,
		shell_completed: completed ? 1 : 0,
		shell_yielded: completed,
		stdin_completed: completed,
		transport: completed
			? (process.platform === "win32" ? "windows_conpty" : "unix_pty")
			: null,
		active_shells: 0,
		trust_persisted: completed,
		full_access_selected: completed,
		persisted: completed,
		cleanup_completed: completed,
		python_started: false,
	};
}

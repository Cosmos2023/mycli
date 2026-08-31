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
import { parseJsonRpcMessage } from "@mycli/contracts";
import { openRuntimeSessionStore } from "@mycli/storage";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";
import { startTestNodeBackend as startNodeBackend } from "./support/offline-update-fetch.ts";

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
	const command = `"${process.execPath}" wait-input.cjs`;
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
					chars: "hello-m6\n",
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
			MYCLI_PROMPT_CACHE_KEY_ENABLED: "false",
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
					command: `"${process.execPath}" wait-input.cjs`,
					tty: true,
					yield_time_ms: 250,
				}));
				return;
			}
			if (requests.length === 2) {
				const shellId = shellIdFromProviderInput(body) ?? "00000000";
				writeSse(response, responsesTool("smoke-input", "WriteStdin", {
					session_id: shellId,
					chars: "hello-m6-smoke\n",
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
	return [
		{
			type: "response.output_item.done",
			item: {
				type: "function_call",
				call_id: callId,
				name,
				arguments: JSON.stringify(argumentsValue),
			},
		},
		{ type: "response.completed", response: { id: `resp-${callId}` } },
	];
}

function responsesFinal(text: string): readonly JsonObject[] {
	return [
		{ type: "response.output_text.delta", delta: text },
		{ type: "response.completed", response: { id: "resp-final" } },
	];
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

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonRpcMessage } from "@mycli/contracts";
import {
	discoverHookConfig,
	HookAllowlistStore,
} from "@mycli/integrations";
import { SQLiteSessionStore } from "@mycli/storage";
import { startNodeBackend, type NodeBackend } from "../src/node-runtime/node-backend.ts";

type JsonObject = Record<string, unknown>;

const ROOT = new URL("../../../", import.meta.url);
const MCP_FIXTURE = fileURLToPath(new URL(
	"packages/integrations/test/fixtures/mcp-stdio-server.mjs",
	ROOT,
));
const HOOK_FIXTURE = fileURLToPath(new URL(
	"packages/integrations/test/fixtures/hook-command.mjs",
	ROOT,
));
const M7_SMOKE = fileURLToPath(new URL("scripts/smoke_node_m7_extensions.mjs", ROOT));

test("M7 live smoke exits 77 with one sanitized result when credentials are unavailable", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m7-smoke-unavailable-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = await runSmoke(workspace, {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		MYCLI_API_KEY: "",
		MYCLI_AUTH_REF: "",
		MYCLI_BASE_URL: "",
	}, "responses");

	assert.equal(result.code, 77);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleJsonLine(result.stdout), smokeResult("responses", "unavailable"));
});

test("M7 live smoke fails when local structural setup cannot start", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m7-smoke-setup-failure-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const invalidTemp = join(root, "not-a-directory");
	await Promise.all([mkdir(home), mkdir(workspace), writeFile(invalidTemp, "fixture", "utf8")]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const result = await runSmoke(workspace, {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: invalidTemp,
		MYCLI_API_KEY: "test-m7-key",
		MYCLI_BASE_URL: "http://127.0.0.1:1/v1",
		MYCLI_PROVIDER: "openai",
		MYCLI_MODEL: "gpt-test",
	}, "responses");

	assert.equal(result.code, 1);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleJsonLine(result.stdout), smokeResult("responses", "failed"));
});

test("M7 live smoke emits only structural extension and cleanup state", {
	timeout: 20_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m7-smoke-completed-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));
	const requests: JsonObject[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(raw) as JsonObject);
			const number = requests.length;
			if (number === 1) writeSse(response, responsesTool("skill", "Skill", { name: "review" }));
			else if (number === 2) {
				writeSse(response, responsesTool("mcp", "mcp_local_echo", { text: "smoke" }));
			} else if (number === 3) {
				writeSse(response, responsesTool("plugin", "plugin_good_echo", { text: "smoke" }));
			} else if (number === 4) {
				writeSse(response, responsesTool("task", "Task", {
					profile: "parity-agent",
					prompt: "Return a structural child report.",
					mode: "foreground",
				}));
			} else if (number === 5) writeSse(response, responsesFinal("private child text", "child"));
			else writeSse(response, responsesFinal("private provider text", "final"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	}));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const secret = "test-m7-live-secret";

	const result = await runSmoke(workspace, {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		MYCLI_API_KEY: secret,
		MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai",
		MYCLI_MODEL: "gpt-test",
	}, "responses");

	assert.equal(result.code, 0, result.stdout);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleJsonLine(result.stdout), smokeResult("responses", "completed"));
	assert.equal(requests.length, 6);
	assert.doesNotMatch(
		result.stdout + result.stderr,
		new RegExp(`${secret}|127\\.0\\.0\\.1|private child text|private provider text`, "u"),
	);
});

test("M7 runs skills MCP hooks plugins and a subagent entirely in Node", {
	timeout: 20_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m7-extensions-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const pythonMarker = join(root, "python-started");
	const hookMarker = join(workspace, "hook-ran");
	const mcpPidFile = join(workspace, "mcp.pid");
	const pluginPidFile = join(workspace, ".mycli", "plugins", "good", "plugin.pid");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	await writeExtensionFixtures({
		home,
		workspace,
		hookMarker,
		mcpPidFile,
		pluginPidFile,
	});
	const hookDiscovery = await discoverHookConfig({ homeDir: home, workspaceRoot: workspace });
	assert.equal(hookDiscovery.hooks.length, 1);
	await new HookAllowlistStore({ homeDir: home }).approve(hookDiscovery.hooks[0]!);

	const requests: JsonObject[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(raw) as JsonObject);
			const number = requests.length;
			if (number === 1) {
				writeSse(response, responsesTool("skill-call", "Skill", { name: "review" }));
			} else if (number === 2) {
				writeSse(response, responsesTool("mcp-call", "mcp_local_echo", { text: "m7" }));
			} else if (number === 3) {
				writeSse(response, responsesTool("plugin-call", "plugin_good_echo", { text: "m7" }));
			} else if (number === 4) {
				writeSse(response, responsesTool("task-call", "Task", {
					profile: "parity-agent",
					prompt: "Return a structural child report.",
					mode: "foreground",
				}));
			} else if (number === 5) {
				writeSse(response, responsesFinal("Child completed M7 work.", "resp-child"));
			} else {
				writeSse(response, responsesFinal("M7 completed.", "resp-final"));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	t.after(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
		await rm(root, { recursive: true, force: true });
	});

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "m7-parent", "--model", "gpt-test"],
		maxOutputTokens: 64,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			MYCLI_API_KEY: "test-m7-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_PYTHON: pythonMarker,
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_REQUEST_MAX_RETRIES: "0",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_PROMPT_CACHE_KEY_ENABLED: "false",
			MYCLI_MEMORY_ENABLED: "false",
			PLUGIN_PID_FILE: pluginPidFile,
		},
	});
	let closed = false;
	const shutdown = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		send(backend, "shutdown", "shutdown", {});
		assert.equal(await backend.completion, 0);
	};
	t.after(shutdown);
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as JsonObject);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	await request(backend, messages, "trust", "workspace.trust.set", { state: "trusted" });
	send(backend, "turn", "turn.submit", {
		message: "Run the M7 extension chain.",
		client_turn_id: "m7-client-turn",
		client_user_message_id: "m7-user-message",
	});

	const approved = new Set<string>();
	for (let index = 0; index < 2; index += 1) {
		let approval: JsonObject;
		try {
			approval = await waitFor(() => events(messages, "approval.request").find((message) => {
				const decisionId = optionalParam(message, "decision_id");
				return decisionId !== undefined && !approved.has(decisionId);
			}), 8_000);
		} catch {
			assert.fail(JSON.stringify(extensionDiagnostics(requests, messages)));
		}
		const decisionId = requiredParam(approval, "decision_id");
		approved.add(decisionId);
		const approvalIndex = messages.indexOf(approval);
		await waitFor(() => messages.slice(approvalIndex + 1).find((message) => (
			message.method === "status.changed"
			&& isObject(message.params)
			&& message.params.pending_decision === true
			&& message.params.turn_running === false
		)));
		await request(backend, messages, `approve-${index}`, "approval.respond", {
			decision_id: decisionId,
			choice: "approve_once",
		});
	}
	const final = await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& isObject(message.params)
		&& message.params.final === true
	)), 10_000);
	assert.equal(isObject(final.params) ? final.params.text : undefined, "M7 completed.");
	assert.equal(requests.length, 6);
	assert.deepEqual(
		events(messages, "tool.complete").map((message) => (
			isObject(message.params) ? message.params.name : undefined
		)),
		["Skill", "mcp_local_echo", "plugin_good_echo", "Task"],
	);
	assert.deepEqual(
		events(messages, "subagent.updated").map((message) => {
			const subagent = isObject(message.params) && isObject(message.params.subagent)
				? message.params.subagent
				: {};
			return subagent.status;
		}),
		["running", "completed"],
	);
	assert.equal(existsSync(hookMarker), true);
	assert.equal(existsSync(pythonMarker), false);
	const mcpPid = Number(await readFile(mcpPidFile, "utf8"));
	const pluginPid = Number(await readFile(pluginPidFile, "utf8"));
	assert.equal(processExists(mcpPid), true);
	assert.equal(processExists(pluginPid), true);

	await shutdown();
	await eventually(() => !processExists(mcpPid) && !processExists(pluginPid));
	const store = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const history = store.loadHistoryItems("m7-parent");
		assert.equal(history.some((item) => item.type === "skill_instructions"), true);
		assert.equal(history.filter((item) => item.type === "tool_result").length, 4);
		const tasks = store.subagentTasks.list("m7-parent");
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0]?.status, "completed");
		assert.equal(tasks[0]?.payload.report, "Child completed M7 work.");
	} finally {
		store.close();
	}
});

async function writeExtensionFixtures(options: {
	readonly home: string;
	readonly workspace: string;
	readonly hookMarker: string;
	readonly mcpPidFile: string;
	readonly pluginPidFile: string;
}): Promise<void> {
	const mycli = join(options.workspace, ".mycli");
	await Promise.all([
		mkdir(join(mycli, "skills"), { recursive: true }),
		mkdir(join(mycli, "agents"), { recursive: true }),
		mkdir(join(mycli, "plugins", "good", "dist"), { recursive: true }),
	]);
	await writeFile(join(mycli, "skills", "review.md"), [
		"---",
		"name: review",
		"description: Review M7 fixture",
		"---",
		"Use the configured M7 extension chain.",
	].join("\n"), "utf8");
	await writeFile(join(mycli, "agents", "parity-agent.md"), [
		"---",
		"name: parity-agent",
		"description: M7 child fixture",
		"tools: [Read]",
		"---",
		"Return a concise structural report.",
	].join("\n"), "utf8");
	await writeFile(join(mycli, "mcp_servers.toml"), [
		"[servers.local]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
		`args = [${JSON.stringify(MCP_FIXTURE)}]`,
		`env = { MCP_PID_FILE = ${JSON.stringify(options.mcpPidFile)} }`,
		"timeout_seconds = 3",
	].join("\n"), "utf8");
	await writeFile(join(mycli, "hooks.json"), JSON.stringify({
		hooks: [{
			id: "m7-marker",
			hook_point: "pre_tool_use",
			command: [process.execPath, HOOK_FIXTURE, "marker", options.hookMarker],
			timeout_seconds: 3,
		}],
	}), "utf8");
	await writeFile(join(mycli, "config.toml"), [
		"[plugins]",
		'enabled = ["good"]',
		"disabled = []",
	].join("\n"), "utf8");
	const pluginRoot = join(mycli, "plugins", "good");
	await writeFile(join(pluginRoot, "plugin.yaml"), [
		"api_version: 2",
		"id: good",
		"name: M7 Good Plugin",
		"version: 1.0.0",
		"entry: dist/index.js",
		"provides:",
		"  tools: [echo]",
		"  hooks: [pre_tool_use]",
		"  commands: []",
		"requires_env: [PLUGIN_PID_FILE]",
		"capabilities: [filesystem_write]",
	].join("\n"), "utf8");
	await writeFile(join(pluginRoot, "dist", "index.js"), [
		'import { writeFile } from "node:fs/promises";',
		"export async function register(context) {",
		"  await writeFile(process.env.PLUGIN_PID_FILE, String(process.pid), 'utf8');",
		"  context.registerTool({",
		"    name: 'echo',",
		"    description: 'Echo M7 text.',",
		"    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },",
		"  }, async (input) => ({ success: true, summary: 'echoed', modelOutput: String(input.text), metadata: {} }));",
		"  context.registerHook({ name: 'allow', hookPoint: 'pre_tool_use' }, async () => ({ action: 'allow' }));",
		"}",
	].join("\n"), "utf8");
	assert.equal(options.pluginPidFile, join(pluginRoot, "plugin.pid"));
}

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

function responsesFinal(text: string, id: string): readonly JsonObject[] {
	return [
		{ type: "response.output_text.delta", delta: text },
		{ type: "response.completed", response: { id } },
	];
}

function writeSse(response: ServerResponse, items: readonly JsonObject[]): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const item of items) response.write(`data: ${JSON.stringify(item)}\n\n`);
	response.end("data: [DONE]\n\n");
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

function requiredParam(message: JsonObject, name: string): string {
	const value = optionalParam(message, name);
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

function optionalParam(message: JsonObject, name: string): string | undefined {
	const value = isObject(message.params) ? message.params[name] : undefined;
	return typeof value === "string" && value ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function extensionDiagnostics(
	requests: readonly JsonObject[],
	messages: readonly JsonObject[],
): JsonObject {
	return {
		request_count: requests.length,
		request_tools: requests.map((request) => Array.isArray(request.tools)
			? request.tools.flatMap((value) => isObject(value) && typeof value.name === "string"
				? [value.name]
				: [])
			: []),
		events: messages.flatMap((message) => typeof message.method === "string"
			? [{
				method: message.method,
				name: isObject(message.params) && typeof message.params.name === "string"
					? message.params.name
					: undefined,
				code: isObject(message.params) && typeof message.params.code === "string"
					? message.params.code
					: undefined,
				error_kind: isObject(message.params) && typeof message.params.error_kind === "string"
					? message.params.error_kind
					: undefined,
				summary: isObject(message.params) && typeof message.params.summary === "string"
					? message.params.summary
					: undefined,
			}]
			: []),
	};
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("M7 extension process did not exit before timeout");
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for M7 extension event");
}

function runSmoke(
	cwd: string,
	env: NodeJS.ProcessEnv,
	protocol: "responses" | "chat_completions" | "anthropic_messages",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [M7_SMOKE, "--protocol", protocol], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
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

function smokeResult(
	protocol: string,
	status: "unavailable" | "failed" | "completed",
): JsonObject {
	const completed = status === "completed";
	return {
		protocol,
		status,
		tool_counts: {
			skill: completed ? 1 : 0,
			mcp: completed ? 1 : 0,
			plugin: completed ? 1 : 0,
			subagent: completed ? 1 : 0,
		},
		hook_completed: completed,
		approval_count: completed ? 2 : 0,
		persisted: completed,
		cleanup_completed: completed,
		python_started: false,
	};
}

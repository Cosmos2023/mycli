import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceTrustStore } from "@mycli/config";
import { parseJsonRpcMessage } from "@mycli/contracts";
import {
	discoverHookConfig,
	HookAllowlistStore,
} from "@mycli/integrations";
import { openRuntimeSessionStore } from "@mycli/storage";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";
import { startTestNodeBackend as startNodeBackend } from "./support/offline-update-fetch.ts";
import {
	responsesAuthorityText,
	responsesTextEvents as responsesFinal,
	responsesToolEvents as responsesTool,
} from "./support/responses-sse.ts";

type JsonObject = Record<string, unknown>;

const ROOT = new URL("../../../../", import.meta.url);
const MCP_FIXTURE = fileURLToPath(new URL(
	"backend/packages/integrations/test/fixtures/mcp-stdio-server.mjs",
	ROOT,
));
const PROCESS_MARKER_FIXTURE = fileURLToPath(new URL(
	"backend/packages/integrations/test/fixtures/process-marker.mjs",
	ROOT,
));
const HOOK_FIXTURE = fileURLToPath(new URL(
	"backend/packages/integrations/test/fixtures/hook-command.mjs",
	ROOT,
));
const M7_SMOKE = fileURLToPath(new URL("scripts/smoke_node_m7_extensions.mjs", ROOT));
const M7_EVENT_TIMEOUT_MS = 20_000;
const M7_TEST_TIMEOUT_MS = 60_000;

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
	timeout: M7_TEST_TIMEOUT_MS,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m7-smoke-completed-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));
	const requests: JsonObject[] = [];
	const parentRequests: JsonObject[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(raw) as JsonObject;
			requests.push(payload);
			if (isSubagentRequest(payload)) {
				writeSse(response, responsesFinal("private child text", "child"));
				return;
			}
			const number = parentRequests.push(payload);
			if (number === 1) writeSse(response, responsesTool("skill", "Skill", { name: "review" }));
			else if (number === 2) {
				writeSse(response, responsesTool("search-mcp", "tool_search", {
					query: "local echo",
					limit: 1,
				}));
			} else if (number === 3) {
				writeSse(response, responsesTool("mcp", "mcp_local_echo", { text: "smoke" }));
			} else if (number === 4) {
				writeSse(response, responsesTool("search-plugin", "tool_search", {
					query: "good echo",
					limit: 1,
				}));
			} else if (number === 5) {
				writeSse(response, responsesTool("plugin", "plugin_good_echo", { text: "smoke" }));
			} else if (number === 6) {
				writeSse(response, responsesTool("task", "spawn_agent", {
					task_name: "m7-smoke",
					message: "Return a structural child report.",
				}));
			} else if (number === 7) {
				writeSse(response, responsesTool("wait", "wait_agent", { timeout_ms: 5_000 }));
			} else writeSse(response, responsesFinal("private provider text", "final"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	}));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const secret = "test-m7-live-secret";

	// Keep context compaction outside this scripted extension workflow.
	const result = await runSmoke(workspace, {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		MYCLI_API_KEY: secret,
		MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai",
		MYCLI_MODEL: "gpt-test",
		MYCLI_MAX_PROMPT_TOKENS: "128000",
		MYCLI_COMPACTION_TOKEN_LIMIT: "128000",
	}, "responses");

	assert.equal(result.code, 0, result.stdout);
	assert.equal(result.stderr, "");
	assert.deepEqual(singleJsonLine(result.stdout), smokeResult("responses", "completed"));
	assert.equal(requests.length, 9);
	assert.equal(providerToolNames(parentRequests[0]!).includes("mcp_local_echo"), false);
	assert.equal(providerToolNames(parentRequests[0]!).includes("plugin_good_echo"), false);
	assert.equal(providerToolNames(parentRequests[2]!).includes("mcp_local_echo"), true);
	assert.equal(providerToolNames(parentRequests[2]!).includes("plugin_good_echo"), false);
	assert.equal(providerToolNames(parentRequests[4]!).includes("mcp_local_echo"), true);
	assert.equal(providerToolNames(parentRequests[4]!).includes("plugin_good_echo"), true);
	assert.doesNotMatch(
		result.stdout + result.stderr,
		new RegExp(`${secret}|127\\.0\\.0\\.1|private child text|private provider text`, "u"),
	);
});

test("Worker-backed root receives refreshed MCP tools on a later provider step", {
	timeout: M7_TEST_TIMEOUT_MS,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m7-worker-mcp-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const mycli = join(workspace, ".mycli");
	const mcpPidFile = join(workspace, "mcp.pid");
	await Promise.all([mkdir(home), mkdir(mycli, { recursive: true })]);
	await writeFile(join(mycli, "mcp_servers.toml"), [
		"[servers.local]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
		`args = [${JSON.stringify(MCP_FIXTURE)}]`,
		`env = { MCP_PID_FILE = ${JSON.stringify(mcpPidFile)} }`,
		"timeout_seconds = 10",
	].join("\n"), "utf8");
	await new WorkspaceTrustStore({ homeDir: home }).save(workspace, "trusted");
	const requests: JsonObject[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(raw) as JsonObject;
			requests.push(payload);
			writeSse(response, requests.length === 1
				? responsesTool("search-mcp-worker", "tool_search", {
					query: "local echo",
					limit: 1,
				})
				: responsesFinal("Worker MCP refresh completed.", "worker-mcp-final"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "worker-mcp-parent", "--model", "gpt-test"],
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			MYCLI_API_KEY: "test-m7-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_REQUEST_MAX_RETRIES: "0",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_CACHE_RETENTION: "none",
			MYCLI_MEMORY_ENABLED: "false",
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		},
	});
	let closed = false;
	const shutdown = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		send(backend, "shutdown-worker-mcp", "shutdown", {});
		assert.equal(await backend.completion, 0);
	};
	t.after(async () => {
		await shutdown();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
		await rm(root, { recursive: true, force: true });
	});
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as JsonObject);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	await waitForExtensionTool(backend, messages, "mcp_local_echo", M7_EVENT_TIMEOUT_MS);
	send(backend, "worker-mcp-turn", "turn.submit", {
		message: "Find the refreshed MCP echo tool.",
		client_turn_id: "worker-mcp-turn",
		client_user_message_id: "worker-mcp-message",
	});
	const final = await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& isObject(message.params)
		&& message.params.final === true
	)), M7_EVENT_TIMEOUT_MS);
	assert.equal(isObject(final.params) ? final.params.text : undefined, "Worker MCP refresh completed.");
	assert.equal(requests.length, 2);
	assert.equal(providerToolNames(requests[0]!).includes("mcp_local_echo"), false);
	assert.equal(providerToolNames(requests[1]!).includes("mcp_local_echo"), true);
	const discoveryTool = (requests[0]!.tools as JsonObject[]).find((tool) => tool.name === "tool_search");
	assert.match(String(discoveryTool?.description), /"mcp:local": "Echo text and read fixture resources\."/u);
	assert.match(String(discoveryTool?.description), /even when the user has not named the MCP server or plugin/u);
	assert.doesNotMatch(String(discoveryTool?.description), /MCP_PID_FILE|mcp\.pid|mcp-stdio-server/u);
	assert.deepEqual(
		events(messages, "tool.complete").map((message) => (
			isObject(message.params) ? message.params.name : undefined
		)),
		["tool_search"],
	);

	assert.equal(existsSync(mcpPidFile), true);
	await shutdown();
	await eventually(() => !existsSync(mcpPidFile));
});

test("workspace trust starts and revocation stops project MCP and plugin hosts", {
	timeout: 15_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m7-trust-reload-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
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
	t.after(async () => { await rm(root, { recursive: true, force: true }); });

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "m7-trust-reload", "--model", "gpt-test"],
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			MYCLI_API_KEY: "test-m7-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
			PLUGIN_PID_FILE: pluginPidFile,
		},
	});
	let closed = false;
	const shutdown = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		send(backend, "shutdown-trust-reload", "shutdown", {});
		assert.equal(await backend.completion, 0);
	};
	t.after(shutdown);
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as JsonObject);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	assert.equal(existsSync(mcpPidFile), false);
	assert.equal(existsSync(pluginPidFile), false);

	const untrustedManifest = await request(
		backend,
		messages,
		"manifest-before-trust",
		"extension.manifest",
		{},
	);
	assert.deepEqual(extensionToolNames(untrustedManifest).filter((name) => (
		name === "mcp_local_echo" || name === "plugin_good_echo"
	)), []);

	await request(backend, messages, "trust-project-hosts", "workspace.trust.set", { state: "trusted" });
	await waitFor(() => existsSync(mcpPidFile) && existsSync(pluginPidFile), 8_000);
	let trustedManifest: JsonObject | undefined;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		trustedManifest = await request(
			backend,
			messages,
			`manifest-after-trust-${attempt}`,
			"extension.manifest",
			{},
		);
		const names = extensionToolNames(trustedManifest);
		if (names.includes("mcp_local_echo") && names.includes("plugin_good_echo")) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.ok(trustedManifest);
	assert.equal(extensionToolNames(trustedManifest).includes("mcp_local_echo"), true);
	assert.equal(extensionToolNames(trustedManifest).includes("plugin_good_echo"), true);
	assert.equal(existsSync(mcpPidFile), true);
	assert.equal(existsSync(pluginPidFile), true);

	await request(backend, messages, "revoke-project-hosts", "workspace.trust.set", { state: "untrusted" });
	const revokedManifest = await request(
		backend,
		messages,
		"manifest-after-revoke",
		"extension.manifest",
		{},
	);
	assert.deepEqual(extensionToolNames(revokedManifest).filter((name) => (
		name === "mcp_local_echo" || name === "plugin_good_echo"
	)), []);
	await eventually(() => !existsSync(mcpPidFile) && !existsSync(pluginPidFile));
	await shutdown();
});

test("M7 runs skills MCP hooks plugins and a subagent entirely in Node", {
	timeout: M7_TEST_TIMEOUT_MS,
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
	await new WorkspaceTrustStore({ homeDir: home }).save(workspace, "trusted");
	const hookDiscovery = await discoverHookConfig({ homeDir: home, workspaceRoot: workspace });
	assert.equal(hookDiscovery.hooks.length, 1);
	await new HookAllowlistStore({ homeDir: home }).approve(hookDiscovery.hooks[0]!);

	const requests: JsonObject[] = [];
	const parentRequests: JsonObject[] = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(raw) as JsonObject;
			requests.push(payload);
			if (isSubagentRequest(payload)) {
				writeSse(response, responsesFinal("Child completed M7 work.", "resp-child"));
				return;
			}
			const number = parentRequests.push(payload);
			if (number === 1) {
				writeSse(response, responsesTool("skill-call", "Skill", { name: "review" }));
			} else if (number === 2) {
				writeSse(response, responsesTool("search-mcp-call", "tool_search", {
					query: "local echo",
					limit: 1,
				}));
			} else if (number === 3) {
				writeSse(response, responsesTool("mcp-call", "mcp_local_echo", { text: "m7" }));
			} else if (number === 4) {
				writeSse(response, responsesTool("search-plugin-call", "tool_search", {
					query: "good echo",
					limit: 1,
				}));
			} else if (number === 5) {
				writeSse(response, responsesTool("plugin-call", "plugin_good_echo", { text: "m7" }));
			} else if (number === 6) {
				writeSse(response, responsesTool("task-call", "spawn_agent", {
					task_name: "m7",
					message: "Return a structural child report.",
				}));
			} else if (number === 7) {
				writeSse(response, responsesTool("wait-call", "wait_agent", { timeout_ms: 5_000 }));
			} else {
				writeSse(response, responsesFinal("M7 completed.", "resp-final"));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const cleanup: { shutdown?: () => Promise<void> } = {};
	t.after(async () => {
		try {
			await cleanup.shutdown?.();
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
			await rm(root, { recursive: true, force: true });
		}
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
			MYCLI_CACHE_RETENTION: "none",
			MYCLI_MEMORY_ENABLED: "false",
			MYCLI_MAX_PROMPT_TOKENS: "128000",
			MYCLI_COMPACTION_TOKEN_LIMIT: "128000",
			COLORTERM: "",
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
	cleanup.shutdown = shutdown;
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as JsonObject);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	await waitForExtensionTool(backend, messages, "mcp_local_echo", M7_EVENT_TIMEOUT_MS);
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
			}), M7_EVENT_TIMEOUT_MS);
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
	)), M7_EVENT_TIMEOUT_MS);
	try {
		await waitFor(() => events(messages, "subagent.updated").find((message) => (
			isObject(message.params)
			&& isObject(message.params.subagent)
			&& message.params.subagent.status === "completed"
		)), M7_EVENT_TIMEOUT_MS);
	} catch {
		assert.fail(JSON.stringify({
			...extensionDiagnostics(requests, messages),
			request_inputs: requests.map((request) => request.input),
			subagents: events(messages, "subagent.updated").map((message) => message.params),
		}, null, 2));
	}
	assert.equal(isObject(final.params) ? final.params.text : undefined, "M7 completed.");
	assert.equal(requests.length, 9);
	assert.deepEqual(
		events(messages, "tool.complete").map((message) => (
			isObject(message.params) ? message.params.name : undefined
		)),
		[
			"Skill",
			"tool_search",
			"mcp_local_echo",
			"tool_search",
			"plugin_good_echo",
			"spawn_agent",
			"wait_agent",
		],
		JSON.stringify(extensionDiagnostics(requests, messages)),
	);
	assert.equal(providerToolNames(parentRequests[0]!).includes("mcp_local_echo"), false);
	assert.equal(providerToolNames(parentRequests[0]!).includes("plugin_good_echo"), false);
	assert.equal(providerToolNames(parentRequests[2]!).includes("mcp_local_echo"), true);
	assert.equal(providerToolNames(parentRequests[2]!).includes("plugin_good_echo"), false);
	assert.equal(providerToolNames(parentRequests[4]!).includes("mcp_local_echo"), true);
	assert.equal(providerToolNames(parentRequests[4]!).includes("plugin_good_echo"), true);
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
	assert.equal(existsSync(mcpPidFile), true);
	assert.equal(existsSync(pluginPidFile), true);

	await shutdown();
	await eventually(() => !existsSync(mcpPidFile) && !existsSync(pluginPidFile));
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const history = store.loadHistoryItems("m7-parent");
		assert.equal(history.some((item) => item.type === "skill_instructions"), true);
		assert.equal(history.filter((item) => item.type === "tool_result").length, 7);
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
		mkdir(join(mycli, "plugins", "good", "dist"), { recursive: true }),
	]);
	await writeFile(join(mycli, "skills", "review.md"), [
		"---",
		"name: review",
		"description: Review M7 fixture",
		"---",
		"Use the configured M7 extension chain.",
	].join("\n"), "utf8");
	await writeFile(join(mycli, "mcp_servers.toml"), [
		"[servers.local]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
		`args = [${JSON.stringify(MCP_FIXTURE)}]`,
		`env = { MCP_PID_FILE = ${JSON.stringify(options.mcpPidFile)} }`,
		"timeout_seconds = 10",
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
		`import { writeProcessMarker } from ${JSON.stringify(pathToFileURL(PROCESS_MARKER_FIXTURE).href)};`,
		"export async function register(context) {",
		"  await writeProcessMarker(process.env.PLUGIN_PID_FILE);",
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

function isSubagentRequest(payload: JsonObject): boolean {
	return responsesAuthorityText(payload).includes("<subagent_context>");
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

async function waitForExtensionTool(
	backend: NodeBackend,
	messages: readonly JsonObject[],
	toolName: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let observedUpdateCount = -1;
	let requestIndex = 0;
	while (Date.now() < deadline) {
		const updateCount = events(messages, "extension.updated").length;
		if (updateCount !== observedUpdateCount) {
			observedUpdateCount = updateCount;
			const response = await request(
				backend,
				messages,
				`extension-tool-${requestIndex}`,
				"extension.manifest",
				{},
			);
			requestIndex += 1;
			if (extensionToolNames(response).includes(toolName)) return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for extension tool: ${toolName}`);
}

function extensionToolNames(response: JsonObject): readonly string[] {
	const result = isObject(response.result) ? response.result : undefined;
	const capabilities = result && isObject(result.capabilities) ? result.capabilities : undefined;
	return capabilities && Array.isArray(capabilities.tool_names)
		? capabilities.tool_names.filter((value): value is string => typeof value === "string")
		: [];
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

function providerToolNames(request: JsonObject): readonly string[] {
	return Array.isArray(request.tools)
		? request.tools.flatMap((tool) => (
			isObject(tool) && typeof tool.name === "string" ? [tool.name] : []
		))
		: [];
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

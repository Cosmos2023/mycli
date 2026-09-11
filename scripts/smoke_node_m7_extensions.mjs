#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveConfig, WorkspaceTrustStore } from "@mycli/config";
import { parseJsonRpcMessage } from "@mycli/contracts";
import {
	discoverHookConfig,
	HookAllowlistStore,
} from "@mycli/integrations";
import { openRuntimeSessionStore } from "@mycli/storage";
import { startNodeBackend } from "../backend/apps/mycli/dist/node-runtime/node-backend.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_FIXTURE = join(
	ROOT,
	"backend",
	"packages",
	"integrations",
	"test",
	"fixtures",
	"mcp-stdio-server.mjs",
);
const PROCESS_MARKER_FIXTURE = join(
	ROOT,
	"backend",
	"packages",
	"integrations",
	"test",
	"fixtures",
	"process-marker.mjs",
);
const HOOK_FIXTURE = join(
	ROOT,
	"backend",
	"packages",
	"integrations",
	"test",
	"fixtures",
	"hook-command.mjs",
);
const DEADLINE_MS = 45_000;
const SKIP_EXIT_CODE = 77;
const PROTOCOLS = new Set(["responses", "chat_completions", "anthropic_messages"]);

async function main() {
	let protocol;
	try {
		const { values } = parseArgs({
			options: { protocol: { type: "string", default: "responses" } },
			strict: true,
			allowPositionals: false,
		});
		protocol = values.protocol;
		if (!PROTOCOLS.has(protocol)) throw new Error("invalid protocol");
	} catch {
		writeSummary(emptySummary("responses", "failed"));
		return 64;
	}

	const sourceHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
	let sourceConfig;
	try {
		sourceConfig = await resolveConfig({
			homeDir: sourceHome,
			workspaceRoot: process.cwd(),
			env: { ...process.env, MYCLI_PROTOCOL: protocol },
			overrides: {
				session: `m7-smoke-config-${randomUUID()}`,
				...(process.env.MYCLI_MODEL?.trim() ? { model: process.env.MYCLI_MODEL.trim() } : {}),
			},
		});
	} catch {
		writeSummary(emptySummary(protocol, "unavailable"));
		return SKIP_EXIT_CODE;
	}
	if (!sourceConfig.apiKey) {
		writeSummary(emptySummary(protocol, "unavailable"));
		return SKIP_EXIT_CODE;
	}

	try {
		const result = await runSmoke(sourceConfig, protocol);
		writeSummary(result.summary);
		return result.exitCode;
	} catch {
		writeSummary(emptySummary(protocol, "failed"));
		return 1;
	}
}

async function runSmoke(sourceConfig, protocol) {
	const tempRoot = await mkdtemp(join(tmpdir(), "mycli-node-m7-smoke-"));
	const homeDir = join(tempRoot, "home");
	const workspaceRoot = join(tempRoot, "workspace");
	const hookMarker = join(workspaceRoot, "hook-ran");
	const mcpPidFile = join(workspaceRoot, "mcp.pid");
	const pluginPidFile = join(workspaceRoot, ".mycli", "plugins", "good", "plugin.pid");
	const pythonMarker = join(tempRoot, "python-started");
	const sessionId = `m7-smoke-${randomUUID()}`;
	const clientTurnId = `client-${randomUUID()}`;
	const deadlineAt = Date.now() + DEADLINE_MS;
	let backend;
	let deadline;
	let messages = [];
	let approvalCount = 0;
	try {
		await Promise.all([mkdir(homeDir), mkdir(workspaceRoot)]);
		await writeExtensionFixtures({
			workspaceRoot,
			hookMarker,
			mcpPidFile,
			pluginPidFile,
		});
		await new WorkspaceTrustStore({ homeDir }).save(workspaceRoot, "trusted");
		const hookDiscovery = await discoverHookConfig({ homeDir, workspaceRoot });
		if (hookDiscovery.hooks.length !== 1) throw new Error("hook discovery failed");
		await new HookAllowlistStore({ homeDir }).approve(hookDiscovery.hooks[0]);
		backend = await startNodeBackend({
			cwd: workspaceRoot,
			args: ["--session", sessionId, "--model", sourceConfig.model],
			maxOutputTokens: 64,
			env: {
				...process.env,
				HOME: homeDir,
				USERPROFILE: homeDir,
				MYCLI_API_KEY: sourceConfig.apiKey,
				MYCLI_BASE_URL: sourceConfig.apiBaseUrl,
				MYCLI_PROVIDER: sourceConfig.provider,
				MYCLI_PROTOCOL: protocol,
				MYCLI_MODEL: sourceConfig.model,
				MYCLI_PYTHON: pythonMarker,
				MYCLI_THINKING_ENABLED: "false",
				MYCLI_REQUEST_MAX_RETRIES: "0",
				MYCLI_STREAM_MAX_RETRIES: "0",
				MYCLI_PROMPT_CACHE_KEY_ENABLED: "false",
				MYCLI_MEMORY_ENABLED: "false",
				PLUGIN_PID_FILE: pluginPidFile,
			},
		});
		deadline = setTimeout(() => { backend?.kill(); }, DEADLINE_MS);
		createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
			messages.push(parseJsonRpcMessage(JSON.parse(line)));
		});
		await waitFor(() => event(messages, "runtime.ready"), deadlineAt);
		await waitForExtensionTool(backend, messages, "mcp_local_echo", deadlineAt);
		await request(backend, messages, "trust", "workspace.trust.set", { state: "trusted" }, deadlineAt);
		send(backend, "turn", "turn.submit", {
			message: [
				"Activate the review skill, use tool_search to discover and activate mcp_local_echo,",
				"then call mcp_local_echo once with text m7-smoke. Use tool_search again to discover",
				"and activate plugin_good_echo, then call it once with text m7-smoke. Call spawn_agent",
				"once with task_name m7-smoke and a short message. Call wait_agent, then finish after",
				"the child completion notification arrives. Use a tool_search limit of 1 each time.",
			].join(" "),
			client_turn_id: clientTurnId,
			client_user_message_id: `user-${randomUUID()}`,
		});
		const approved = new Set();
		while (approvalCount < 2) {
			const next = await waitFor(() => {
				const terminal = terminalMessage(messages, clientTurnId);
				if (terminal) return { kind: "terminal", message: terminal };
				const approval = events(messages, "approval.request").find((message) => {
					const id = optionalParam(message, "decision_id");
					return id && !approved.has(id);
				});
				return approval ? { kind: "approval", message: approval } : undefined;
			}, deadlineAt);
			if (next.kind === "terminal") break;
			const approval = next.message;
			const decisionId = requiredParam(approval, "decision_id");
			approved.add(decisionId);
			const approvalIndex = messages.indexOf(approval);
			await waitFor(() => messages.slice(approvalIndex + 1).find((message) => (
				message.method === "status.changed"
				&& isObject(message.params)
				&& message.params.pending_decision === true
				&& message.params.turn_running === false
			)), deadlineAt);
			await request(
				backend,
				messages,
				`approve-${approvalCount}`,
				"approval.respond",
				{ decision_id: decisionId, choice: "approve_once" },
				deadlineAt,
			);
			approvalCount += 1;
		}
		const terminal = await waitFor(() => terminalMessage(messages, clientTurnId), deadlineAt);
		const counts = toolCounts(messages);
		const providerUnavailable = terminal.method === "turn.failed"
			&& Object.values(counts).every((count) => count === 0);
		if (providerUnavailable) {
			await shutdown(backend);
			backend = undefined;
			return { summary: emptySummary(protocol, "unavailable"), exitCode: SKIP_EXIT_CODE };
		}

		const extensionProcessesStarted = existsSync(mcpPidFile) && existsSync(pluginPidFile);
		const exitCode = await shutdown(backend);
		backend = undefined;
		const cleanupCompleted = exitCode === 0
			&& extensionProcessesStarted
			&& await eventually(() => !existsSync(mcpPidFile) && !existsSync(pluginPidFile));
		const hookCompleted = existsSync(hookMarker);
		const pythonStarted = existsSync(pythonMarker);
		const persisted = persistedState(homeDir, sessionId, counts);
		const completed = terminal.method === "message.complete"
			&& Object.values(counts).every((count) => count === 1)
			&& toolSearchCount(messages) === 2
			&& hookCompleted
			&& approvalCount === 2
			&& persisted
			&& cleanupCompleted
			&& !pythonStarted;
		return {
			summary: {
				protocol,
				status: completed ? "completed" : "failed",
				tool_counts: counts,
				hook_completed: hookCompleted,
				approval_count: approvalCount,
				persisted,
				cleanup_completed: cleanupCompleted,
				python_started: pythonStarted,
			},
			exitCode: completed ? 0 : 1,
		};
	} finally {
		if (deadline !== undefined) clearTimeout(deadline);
		await backend?.close().catch(() => undefined);
		messages = [];
		await rm(tempRoot, { recursive: true, force: true });
	}
}

async function writeExtensionFixtures(options) {
	const mycli = join(options.workspaceRoot, ".mycli");
	const pluginRoot = join(mycli, "plugins", "good");
	await Promise.all([
		mkdir(join(mycli, "skills"), { recursive: true }),
		mkdir(join(pluginRoot, "dist"), { recursive: true }),
	]);
	await writeFile(join(mycli, "skills", "review.md"), [
		"---",
		"name: review",
		"description: Review M7 smoke fixture",
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
	await writeFile(join(pluginRoot, "plugin.yaml"), [
		"api_version: 2",
		"id: good",
		"name: M7 Smoke Plugin",
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
		"    name: 'echo', description: 'Echo M7 smoke text.',",
		"    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },",
		"  }, async (input) => ({ success: true, summary: 'echoed', modelOutput: String(input.text), metadata: {} }));",
		"  context.registerHook({ name: 'allow', hookPoint: 'pre_tool_use' }, async () => ({ action: 'allow' }));",
		"}",
	].join("\n"), "utf8");
}

function persistedState(homeDir, sessionId, counts) {
	const store = openRuntimeSessionStore({ dbPath: join(homeDir, ".mycli", "sessions.db") });
	try {
		const history = store.loadHistoryItems(sessionId);
		const tasks = store.subagentTasks.list(sessionId);
		return history.some((item) => item.type === "skill_instructions")
			&& history.filter((item) => item.type === "tool_result").length === 7
			&& tasks.length === 1
			&& tasks[0]?.status === "completed"
			&& Object.values(counts).every((count) => count === 1);
	} finally {
		store.close();
	}
}

function toolCounts(messages) {
	const counts = { skill: 0, mcp: 0, plugin: 0, subagent: 0 };
	for (const message of events(messages, "tool.complete")) {
		const name = isObject(message.params) ? message.params.name : undefined;
		if (name === "Skill") counts.skill += 1;
		else if (typeof name === "string" && name.startsWith("mcp_")) counts.mcp += 1;
		else if (typeof name === "string" && name.startsWith("plugin_")) counts.plugin += 1;
		else if (name === "spawn_agent") counts.subagent += 1;
	}
	return counts;
}

function toolSearchCount(messages) {
	return events(messages, "tool.complete").filter((message) => (
		isObject(message.params) && message.params.name === "tool_search"
	)).length;
}

function send(backend, id, method, params) {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

async function request(backend, messages, id, method, params, deadlineAt) {
	send(backend, id, method, params);
	const response = await waitFor(
		() => messages.find((message) => String(message.id) === id),
		deadlineAt,
	);
	if ("error" in response) throw new Error("smoke_rpc_failed");
	return response;
}

async function waitForExtensionTool(backend, messages, toolName, deadlineAt) {
	let observedUpdateCount = -1;
	let requestIndex = 0;
	while (Date.now() < deadlineAt) {
		const updateCount = events(messages, "extension.updated").length;
		if (updateCount !== observedUpdateCount) {
			observedUpdateCount = updateCount;
			const response = await request(
				backend,
				messages,
				`extension-tool-${requestIndex}`,
				"extension.manifest",
				{},
				deadlineAt,
			);
			requestIndex += 1;
			if (extensionToolNames(response).includes(toolName)) return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("smoke_extension_timeout");
}

function extensionToolNames(response) {
	const result = isObject(response.result) ? response.result : undefined;
	const capabilities = result && isObject(result.capabilities) ? result.capabilities : undefined;
	return capabilities && Array.isArray(capabilities.tool_names)
		? capabilities.tool_names.filter((value) => typeof value === "string")
		: [];
}

async function shutdown(backend) {
	send(backend, "shutdown", "shutdown", {});
	return backend.completion;
}

function terminalMessage(messages, clientTurnId) {
	return messages.find((message) => (
		(message.method === "turn.failed"
			|| message.method === "turn.interrupted"
			|| message.method === "message.complete")
		&& isObject(message.params)
		&& message.params.client_turn_id === clientTurnId
		&& (message.method !== "message.complete" || message.params.final === true)
	));
}

function event(messages, method) {
	return messages.find((message) => message.method === method && !("id" in message));
}

function events(messages, method) {
	return messages.filter((message) => message.method === method && !("id" in message));
}

function requiredParam(message, name) {
	const value = optionalParam(message, name);
	if (!value) throw new Error("smoke_protocol_failed");
	return value;
}

function optionalParam(message, name) {
	const value = isObject(message.params) ? message.params[name] : undefined;
	return typeof value === "string" && value ? value : undefined;
}

async function eventually(predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return predicate();
}

async function waitFor(read, deadlineAt) {
	while (Date.now() < deadlineAt) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("smoke_timeout");
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptySummary(protocol, status) {
	return {
		protocol,
		status,
		tool_counts: { skill: 0, mcp: 0, plugin: 0, subagent: 0 },
		hook_completed: false,
		approval_count: 0,
		persisted: false,
		cleanup_completed: false,
		python_started: false,
	};
}

function writeSummary(summary) {
	process.stdout.write(`${JSON.stringify(summary)}\n`);
}

process.exitCode = await main();

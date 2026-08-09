#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { resolveConfig } from "@mycli/config";
import { parseJsonRpcMessage } from "@mycli/contracts";
import { SQLiteSessionStore } from "@mycli/storage";
import { startNodeBackend } from "../backend/apps/mycli/dist/node-runtime/node-backend.js";

const DEADLINE_MS = 180_000;
const SKIP_EXIT_CODE = 77;
const PROTOCOLS = new Set(["responses", "chat_completions", "anthropic_messages"]);
const COORDINATION_TOOLS = new Set([
	"spawn_agent",
	"send_message",
	"followup_task",
	"wait_agent",
	"interrupt_agent",
	"list_agents",
]);

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
		writeSummary(emptySummary("responses", "failed", "unknown"));
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
				session: `agent-smoke-config-${randomUUID()}`,
				...(process.env.MYCLI_MODEL?.trim() ? { model: process.env.MYCLI_MODEL.trim() } : {}),
			},
		});
	} catch {
		writeSummary(emptySummary(protocol, "unavailable", "unknown"));
		return SKIP_EXIT_CODE;
	}
	if (!sourceConfig.apiKey) {
		writeSummary(emptySummary(protocol, "unavailable", "missing"));
		return SKIP_EXIT_CODE;
	}

	try {
		const result = await runSmoke(sourceConfig, protocol);
		writeSummary(result.summary);
		return result.exitCode;
	} catch {
		writeSummary(emptySummary(protocol, "failed", "configured"));
		return 1;
	}
}

async function runSmoke(sourceConfig, protocol) {
	const tempRoot = await mkdtemp(join(tmpdir(), "mycli-node-agent-smoke-"));
	const homeDir = join(tempRoot, "home");
	const workspaceRoot = join(tempRoot, "workspace");
	const pythonMarker = join(tempRoot, "python-started");
	const sessionId = `agent-smoke-${randomUUID()}`;
	const deadlineAt = Date.now() + DEADLINE_MS;
	let active;
	try {
		await Promise.all([mkdir(homeDir), mkdir(workspaceRoot)]);
		await writeFile(
			join(workspaceRoot, "agent-smoke.txt"),
			"NODE_AGENT_SMOKE_MARKER\n",
			"utf8",
		);

		active = await launchBackend({
			homeDir,
			workspaceRoot,
			pythonMarker,
			sessionId,
			sourceConfig,
			protocol,
			deadlineAt,
		});
		await trustWorkspace(active, deadlineAt);

		await runCoordinationTurn(active, ["spawn_agent"], [
			"Call spawn_agent exactly once with task_name reader-smoke,",
			"fork_turns none, and this child message: Use Read exactly once on",
			"agent-smoke.txt with offset 1 and limit 20, report the marker, then finish.",
			"After the tool result, reply with spawned. Do not call any other tool.",
		].join(" "), deadlineAt);
		await runCoordinationTurn(active, ["send_message"], [
			"Call send_message exactly once with target reader-smoke and message",
			"Parent queue-only smoke message. After the tool result, reply with sent.",
			"Do not call any other tool.",
		].join(" "), deadlineAt);
		await runCoordinationTurn(active, ["wait_agent"], [
			"Call wait_agent exactly once with timeout_ms 60000, then reply with waited.",
			"Do not call any other tool.",
		].join(" "), deadlineAt);
		await waitFor(
			() => subagentStatusCount(active.messages, "reader-smoke", "completed") >= 1,
			deadlineAt,
		);

		await runCoordinationTurn(active, ["followup_task"], [
			"Call followup_task exactly once with target reader-smoke and this message:",
			"Use Read exactly once on agent-smoke.txt with offset 1 and limit 20 again,",
			"then report the follow-up marker. After the tool result, reply with triggered.",
			"Do not call any other tool.",
		].join(" "), deadlineAt);
		await runCoordinationTurn(active, ["wait_agent"], [
			"Call wait_agent exactly once with timeout_ms 60000, then reply with waited.",
			"Do not call any other tool.",
		].join(" "), deadlineAt);
		await waitFor(
			() => subagentStatusCount(active.messages, "reader-smoke", "completed") >= 2,
			deadlineAt,
		);

		await runCoordinationTurn(active, ["spawn_agent", "interrupt_agent"], [
			"First call spawn_agent with task_name interrupt-smoke,",
			"fork_turns none, and this child message: Repeatedly call Read on",
			"agent-smoke.txt with offset 1 and limit 20; do not finish until 100",
			"successful Read calls. As soon as spawn_agent returns, call interrupt_agent",
			"with target interrupt-smoke and reason real provider smoke interruption.",
			"Then reply with interrupted. Do not call any other tool.",
		].join(" "), deadlineAt);
		await waitFor(
			() => subagentStatusCount(active.messages, "interrupt-smoke", "interrupted") >= 1,
			deadlineAt,
		);

		const firstMessages = [...active.messages];
		await stopBackend(active);
		active = undefined;
		const beforeReload = inspectPersistedState(homeDir, sessionId);

		active = await launchBackend({
			homeDir,
			workspaceRoot,
			pythonMarker,
			sessionId,
			sourceConfig,
			protocol,
			deadlineAt,
		});
		await trustWorkspace(active, deadlineAt);
		const bootstrap = await request(
			active,
			`bootstrap-${randomUUID()}`,
			"session.bootstrap",
			{ protocol_version: 1 },
			deadlineAt,
		);
		const transcript = await request(
			active,
			`transcript-${randomUUID()}`,
			"transcript.load",
			{ session_id: sessionId },
			deadlineAt,
		);
		await runCoordinationTurn(active, ["list_agents"], [
			"Call list_agents exactly once with no arguments, then reply with listed.",
			"Do not call any other tool.",
		].join(" "), deadlineAt);
		const secondMessages = [...active.messages];
		await stopBackend(active);
		active = undefined;
		const afterReload = inspectPersistedState(homeDir, sessionId);

		const bootstrapSessionId = isObject(bootstrap.result)
			? bootstrap.result.session_id
			: undefined;
		const transcriptItems = isObject(transcript.result) && Array.isArray(transcript.result.items)
			? transcript.result.items
			: [];
		const toolCounts = coordinationToolCounts([...firstMessages, ...secondMessages]);
		const sessionReloaded = bootstrapSessionId === sessionId && transcriptItems.length > 0;
		const backendReloaded = sessionReloaded
			&& toolCounts.list_agents === 1
			&& sameAgentIdentity(beforeReload.agentIdentity, afterReload.agentIdentity);
		const completed = toolCounts.spawn_agent === 2
			&& toolCounts.send_message === 1
			&& toolCounts.followup_task === 1
			&& toolCounts.wait_agent === 2
			&& toolCounts.interrupt_agent === 1
			&& toolCounts.list_agents === 1
			&& afterReload.childReadCount >= 2
			&& afterReload.completionObserved
			&& afterReload.interruptionObserved
			&& afterReload.mailboxPersisted
			&& afterReload.agentTreePersisted
			&& sessionReloaded
			&& backendReloaded
			&& !existsSync(pythonMarker);
		return {
			summary: {
				protocol,
				status: completed ? "completed" : "failed",
				tool_counts: toolCounts,
				child_read_count: afterReload.childReadCount,
				completion_observed: afterReload.completionObserved,
				interruption_observed: afterReload.interruptionObserved,
				mailbox_persisted: afterReload.mailboxPersisted,
				agent_tree_persisted: afterReload.agentTreePersisted,
				session_reloaded: sessionReloaded,
				backend_reloaded: backendReloaded,
				python_started: existsSync(pythonMarker),
				credential: "configured",
			},
			exitCode: completed ? 0 : 1,
		};
	} finally {
		await active?.backend.close().catch(() => undefined);
		active?.reader.close();
		await rm(tempRoot, { recursive: true, force: true });
	}
}

async function launchBackend(options) {
	const backend = await startNodeBackend({
		cwd: options.workspaceRoot,
		args: ["--session", options.sessionId, "--model", options.sourceConfig.model],
		maxOutputTokens: 256,
		env: {
			...process.env,
			HOME: options.homeDir,
			USERPROFILE: options.homeDir,
			MYCLI_API_KEY: options.sourceConfig.apiKey,
			MYCLI_BASE_URL: options.sourceConfig.apiBaseUrl,
			MYCLI_PROVIDER: options.sourceConfig.provider,
			MYCLI_PROTOCOL: options.protocol,
			MYCLI_MODEL: options.sourceConfig.model,
			MYCLI_PYTHON: options.pythonMarker,
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_REQUEST_MAX_RETRIES: "0",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_PROMPT_CACHE_KEY_ENABLED: "false",
			MYCLI_MEMORY_ENABLED: "false",
		},
	});
	const messages = [];
	const reader = createInterface({ input: backend.transport.input, crlfDelay: Infinity });
	reader.on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)));
	});
	const runtime = { backend, messages, reader };
	await waitFor(() => event(messages, "runtime.ready"), options.deadlineAt);
	return runtime;
}

async function trustWorkspace(runtime, deadlineAt) {
	await request(
		runtime,
		`trust-${randomUUID()}`,
		"workspace.trust.set",
		{ state: "trusted" },
		deadlineAt,
	);
}

async function runCoordinationTurn(runtime, expectedTools, message, deadlineAt) {
	const before = coordinationToolNames(runtime.messages).length;
	const clientTurnId = `agent-smoke-turn-${randomUUID()}`;
	send(runtime.backend, `submit-${randomUUID()}`, "turn.submit", {
		message,
		client_turn_id: clientTurnId,
		client_user_message_id: `agent-smoke-message-${randomUUID()}`,
	});
	const terminal = await waitFor(
		() => terminalMessage(runtime.messages, clientTurnId),
		deadlineAt,
	);
	if (terminal.method !== "message.complete") throw new Error("agent_smoke_turn_failed");
	const actual = coordinationToolNames(runtime.messages).slice(before);
	if (JSON.stringify(actual) !== JSON.stringify(expectedTools)) {
		throw new Error("agent_smoke_tool_sequence_failed");
	}
}

async function request(runtime, id, method, params, deadlineAt) {
	send(runtime.backend, id, method, params);
	const response = await waitFor(
		() => runtime.messages.find((message) => String(message.id) === id),
		deadlineAt,
	);
	if ("error" in response) throw new Error("agent_smoke_rpc_failed");
	return response;
}

async function stopBackend(runtime) {
	send(runtime.backend, `shutdown-${randomUUID()}`, "shutdown", {});
	const exitCode = await runtime.backend.completion;
	runtime.reader.close();
	if (exitCode !== 0) throw new Error("agent_smoke_shutdown_failed");
}

function inspectPersistedState(homeDir, sessionId) {
	const store = new SQLiteSessionStore({ dbPath: join(homeDir, ".mycli", "sessions.db") });
	try {
		const root = store.loadSession(sessionId);
		if (!root) return emptyPersistedState();
		const agents = store.agentThreads.list({ rootThreadId: root.threadId });
		const reader = agents.find((agent) => agent.taskName === "reader-smoke");
		const interrupted = agents.find((agent) => agent.taskName === "interrupt-smoke");
		const tasks = store.subagentTasks.list(sessionId);
		const readerHistory = reader ? store.loadHistoryItems(reader.threadId) : [];
		const readerMailbox = reader
			? store.agentMailbox.list({ receiverThreadId: reader.threadId })
			: [];
		const parentMailbox = store.agentMailbox.list({ receiverThreadId: root.threadId });
		const readerCompletedTasks = reader
			? tasks.filter((task) => (
				task.childSessionId === reader.threadId && task.status === "completed"
			)).length
			: 0;
		const interruptedTasks = interrupted
			? tasks.filter((task) => (
				task.childSessionId === interrupted.threadId && task.status === "interrupted"
			)).length
			: 0;
		return {
			agentIdentity: agents.map((agent) => (
				`${agent.threadId}\0${agent.path}\0${agent.taskName}`
			)).sort(),
			childReadCount: readerHistory.filter((item) => (
				item.type === "tool_call" && item.tool_name === "Read"
			)).length,
			completionObserved: readerCompletedTasks >= 2
				&& parentMailbox.filter((item) => (
					item.payload.kind === "completion" && item.state === "committed"
				)).length >= 2,
			interruptionObserved: interrupted?.status === "interrupted" && interruptedTasks >= 1,
			mailboxPersisted: readerMailbox.some((item) => (
				item.payload.kind === "message" && item.triggerMode === "queue_only"
			)) && readerMailbox.some((item) => (
				item.payload.kind === "message" && item.triggerMode === "follow_up"
			)),
			agentTreePersisted: agents.length >= 2 && reader !== undefined && interrupted !== undefined,
		};
	} finally {
		store.close();
	}
}

function coordinationToolCounts(messages) {
	const counts = Object.fromEntries([...COORDINATION_TOOLS].map((name) => [name, 0]));
	for (const name of coordinationToolNames(messages)) counts[name] += 1;
	return counts;
}

function coordinationToolNames(messages) {
	return messages.flatMap((message) => {
		if (message.method !== "tool.complete" || !isObject(message.params)) return [];
		const name = message.params.name;
		return typeof name === "string" && COORDINATION_TOOLS.has(name) ? [name] : [];
	});
}

function subagentStatusCount(messages, taskName, status) {
	return messages.filter((message) => {
		if (message.method !== "subagent.updated" || !isObject(message.params)) return false;
		const subagent = message.params.subagent;
		return isObject(subagent)
			&& subagent.task_name === taskName
			&& subagent.status === status;
	}).length;
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

function send(backend, id, method, params) {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

async function waitFor(read, deadlineAt) {
	while (Date.now() < deadlineAt) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("agent_smoke_timeout");
}

function emptyPersistedState() {
	return {
		agentIdentity: [],
		childReadCount: 0,
		completionObserved: false,
		interruptionObserved: false,
		mailboxPersisted: false,
		agentTreePersisted: false,
	};
}

function sameAgentIdentity(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptySummary(protocol, status, credential) {
	return {
		protocol,
		status,
		tool_counts: Object.fromEntries([...COORDINATION_TOOLS].map((name) => [name, 0])),
		child_read_count: 0,
		completion_observed: false,
		interruption_observed: false,
		mailbox_persisted: false,
		agent_tree_persisted: false,
		session_reloaded: false,
		backend_reloaded: false,
		python_started: false,
		credential,
	};
}

function writeSummary(summary) {
	process.stdout.write(`${JSON.stringify(summary)}\n`);
}

process.exitCode = await main();

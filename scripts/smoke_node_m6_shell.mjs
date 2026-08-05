#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { parseJsonRpcMessage } from "@mycli/contracts";
import { resolveConfig, WorkspaceTrustStore } from "@mycli/config";
import { SQLiteSessionStore } from "@mycli/storage";
import { startNodeBackend } from "../apps/mycli/dist/node-runtime/node-backend.js";

const MAX_OUTPUT_TOKENS = 64;
const DEADLINE_MS = 30_000;
const SKIP_EXIT_CODE = 77;
const OFFICIAL_OPENAI_HOST = "api.openai.com";

async function main() {
	let values;
	try {
		({ values } = parseArgs({
			options: { protocol: { type: "string", default: "responses" } },
			strict: true,
			allowPositionals: false,
		}));
	} catch {
		writeSummary(emptySummary("failed"));
		return 64;
	}
	if (values.protocol !== "responses") {
		writeSummary(emptySummary("failed"));
		return 64;
	}

	const sourceHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
	let sourceConfig;
	try {
		sourceConfig = await resolveConfig({
			homeDir: sourceHome,
			workspaceRoot: process.cwd(),
			env: process.env,
			overrides: { session: `m6-smoke-config-${randomUUID()}`, model: "gpt-5.5" },
		});
	} catch {
		writeSummary(emptySummary("unavailable"));
		return SKIP_EXIT_CODE;
	}
	if (!sourceConfig.apiKey || isOfficialOpenAIUrl(sourceConfig.apiBaseUrl)) {
		writeSummary(emptySummary("unavailable"));
		return SKIP_EXIT_CODE;
	}

	try {
		const result = await runSmoke(sourceConfig);
		writeSummary(result.summary);
		return result.exitCode;
	} catch {
		writeSummary(emptySummary("unavailable"));
		return SKIP_EXIT_CODE;
	}
}

async function runSmoke(sourceConfig) {
	const tempRoot = await mkdtemp(join(tmpdir(), "mycli-node-m6-smoke-"));
	const homeDir = join(tempRoot, "home");
	const workspaceRoot = join(tempRoot, "workspace");
	const pythonMarker = join(tempRoot, "python-started");
	const sessionId = `m6-smoke-${randomUUID()}`;
	const clientTurnId = `client-${randomUUID()}`;
	const deadlineAt = Date.now() + DEADLINE_MS;
	let backend;
	let deadline;
	try {
		await Promise.all([mkdir(homeDir), mkdir(workspaceRoot)]);
		await writeFile(join(workspaceRoot, "wait-input.cjs"), [
			"process.stdin.setEncoding('utf8');",
			"process.stdin.once('data', (value) => {",
			"  process.stdout.write('stdin-complete:' + value.trim() + '\\n', () => process.exit(0));",
			"});",
		].join("\n"), "utf8");
		const command = `"${process.execPath}" wait-input.cjs`;
		backend = await startNodeBackend({
			cwd: workspaceRoot,
			args: ["--session", sessionId, "--model", "gpt-5.5"],
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			env: {
				...process.env,
				HOME: homeDir,
				USERPROFILE: homeDir,
				MYCLI_API_KEY: sourceConfig.apiKey,
				MYCLI_BASE_URL: sourceConfig.apiBaseUrl,
				MYCLI_PROVIDER: sourceConfig.provider,
				MYCLI_PROTOCOL: "responses",
				MYCLI_MODEL: "gpt-5.5",
				MYCLI_THINKING_ENABLED: "false",
				MYCLI_REQUEST_MAX_RETRIES: "0",
				MYCLI_STREAM_MAX_RETRIES: "0",
				MYCLI_PROMPT_CACHE_KEY_ENABLED: "false",
				MYCLI_MEMORY_ENABLED: "false",
				MYCLI_PYTHON: pythonMarker,
			},
		});
		deadline = setTimeout(() => { backend?.kill(); }, DEADLINE_MS);
		const messages = [];
		createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
			messages.push(parseJsonRpcMessage(JSON.parse(line)));
		});
		await waitFor(() => event(messages, "runtime.ready"), deadlineAt);
		const trust = await request(
			backend,
			messages,
			"trust",
			"workspace.trust.set",
			{ state: "trusted" },
			deadlineAt,
		);
		const permission = await request(
			backend,
			messages,
			"permission",
			"permissions.update",
			{ profile: "full-access" },
			deadlineAt,
		);
		const fullAccessSelected = isObject(permission.result)
			&& isObject(permission.result.permissions)
			&& permission.result.permissions.active === "full-access";
		send(backend, "turn", "turn.submit", {
			message: [
				"Use Shell exactly once with tty=true and yield_time_ms=250 to run this command:",
				command,
				"When it yields a session ID, use WriteStdin exactly once with chars=hello-m6-smoke followed by a newline and yield_time_ms=3000.",
				"After the terminal completes, give a brief final response without another tool call.",
			].join("\n"),
			client_turn_id: clientTurnId,
			client_user_message_id: `user-${randomUUID()}`,
		});
		const approval = await waitFor(() => event(messages, "approval.request"), deadlineAt);
		await waitFor(() => events(messages, "status.changed").find((message) => (
			isObject(message.params)
			&& message.params.pending_decision === true
			&& message.params.turn_running === false
		)), deadlineAt);
		await request(
			backend,
			messages,
			"approve",
			"approval.respond",
			{
				decision_id: requiredParam(approval, "decision_id"),
				choice: "approve_once",
			},
			deadlineAt,
		);
		const terminal = await waitFor(() => terminalMessage(messages, clientTurnId), deadlineAt);
		const providerUnavailable = terminal.method === "turn.failed"
			&& events(messages, "tool.failed").length === 0;
		if (providerUnavailable) {
			await shutdown(backend);
			backend = undefined;
			return { summary: emptySummary("unavailable"), exitCode: SKIP_EXIT_CODE };
		}

		const shellList = await request(
			backend,
			messages,
			"shell-list",
			"shell.list",
			{},
			deadlineAt,
		);
		const activeShells = isObject(shellList.result) && Array.isArray(shellList.result.shells)
			? shellList.result.shells.length
			: -1;
		const shellStarted = events(messages, "shell.started");
		const shellCompleted = events(messages, "shell.completed");
		const yielded = events(messages, "shell.list.updated").some((message) => (
			isObject(message.params) && message.params.yielded === true
		));
		const stdinCompleted = events(messages, "tool.complete").some((message) => (
			isObject(message.params)
			&& message.params.name === "WriteStdin"
			&& message.params.success === true
		));
		const transport = shellTransport(shellStarted, shellCompleted);
		const exitCode = await shutdown(backend);
		backend = undefined;
		const cleanupCompleted = exitCode === 0 && activeShells === 0;
		const trustPersisted = isObject(trust.result)
			&& trust.result.state === "trusted"
			&& await new WorkspaceTrustStore({ homeDir }).load(workspaceRoot) === "trusted";
		const persisted = persistedShellState({
			homeDir,
			sessionId,
			clientTurnId,
			transport,
		});
		const pythonStarted = existsSync(pythonMarker);
		const completed = terminal.method === "message.complete"
			&& shellStarted.length === 1
			&& shellCompleted.length === 1
			&& yielded
			&& stdinCompleted
			&& isNativePtyTransport(transport)
			&& activeShells === 0
			&& trustPersisted
			&& fullAccessSelected
			&& persisted
			&& cleanupCompleted
			&& !pythonStarted;
		return {
			summary: {
				protocol: "responses",
				status: completed ? "completed" : "failed",
				shell_started: shellStarted.length,
				shell_completed: shellCompleted.length,
				shell_yielded: yielded,
				stdin_completed: stdinCompleted,
				transport,
				active_shells: activeShells,
				trust_persisted: trustPersisted,
				full_access_selected: fullAccessSelected,
				persisted,
				cleanup_completed: cleanupCompleted,
				python_started: pythonStarted,
			},
			exitCode: completed ? 0 : 1,
		};
	} finally {
		if (deadline !== undefined) clearTimeout(deadline);
		await backend?.close().catch(() => undefined);
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function persistedShellState(options) {
	const store = new SQLiteSessionStore({
		dbPath: join(options.homeDir, ".mycli", "sessions.db"),
	});
	try {
		const turn = store.loadTurn(options.sessionId, options.clientTurnId);
		const shellItems = store.loadHistoryItems(options.sessionId)
			.filter((item) => item.type === "shell_session");
		if (turn?.status !== "completed" || shellItems.length !== 1) return false;
		const metadata = isObject(shellItems[0]?.metadata) ? shellItems[0].metadata : {};
		return metadata.tty === true
			&& metadata.yielded === true
			&& metadata.terminal_state === "completed"
			&& metadata.transport === options.transport
			&& typeof metadata.output === "string"
			&& metadata.output.includes("stdin-complete:hello-m6-smoke");
	} finally {
		store.close();
	}
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
	const value = isObject(message.params) ? message.params[name] : undefined;
	if (typeof value !== "string" || !value) throw new Error("smoke_protocol_failed");
	return value;
}

function shellTransport(started, completed) {
	for (const message of [...completed, ...started]) {
		if (!isObject(message.params)) continue;
		const transport = message.params.transport;
		if (transport === "unix_pty" || transport === "windows_conpty") return transport;
	}
	return null;
}

function isNativePtyTransport(value) {
	return process.platform === "win32"
		? value === "windows_conpty"
		: value === "unix_pty";
}

async function waitFor(read, deadlineAt) {
	while (Date.now() < deadlineAt) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("smoke_timeout");
}

function isOfficialOpenAIUrl(value) {
	try {
		return new URL(value).hostname.toLowerCase() === OFFICIAL_OPENAI_HOST;
	} catch {
		return true;
	}
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptySummary(status) {
	return {
		protocol: "responses",
		status,
		shell_started: 0,
		shell_completed: 0,
		shell_yielded: false,
		stdin_completed: false,
		transport: null,
		active_shells: 0,
		trust_persisted: false,
		full_access_selected: false,
		persisted: false,
		cleanup_completed: false,
		python_started: false,
	};
}

function writeSummary(summary) {
	process.stdout.write(`${JSON.stringify(summary)}\n`);
}

process.exitCode = await main();

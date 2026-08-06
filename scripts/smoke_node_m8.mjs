#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { parseJsonRpcMessage } from "@mycli/contracts";
import { startNodeBackend } from "../apps/mycli/dist/node-runtime/node-backend.js";

const DEADLINE_MS = 15_000;
const EXPECTED_VISIBLE_COMMANDS = 16;

async function main() {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m8-smoke-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const pythonMarker = join(root, "python-started");
	let backend;
	let reader;
	try {
		await Promise.all([mkdir(homeDir), mkdir(workspaceRoot)]);
		backend = await startNodeBackend({
			cwd: workspaceRoot,
			args: ["--session", "m8-provider-free-smoke"],
			env: {
				...process.env,
				HOME: homeDir,
				USERPROFILE: homeDir,
				MYCLI_API_KEY: "",
				MYCLI_AUTH_REF: "",
				MYCLI_PYTHON: pythonMarker,
			},
		});
		const messages = [];
		reader = createInterface({ input: backend.transport.input, crlfDelay: Infinity });
		reader.on("line", (line) => messages.push(parseJsonRpcMessage(JSON.parse(line))));
		const deadlineAt = Date.now() + DEADLINE_MS;
		await waitFor(() => messages.find((message) => message.method === "runtime.ready"), deadlineAt);
		const bootstrap = await request(
			backend,
			messages,
			"bootstrap",
			"session.bootstrap",
			{ protocol_version: 1 },
			deadlineAt,
		);
		const commands = await request(
			backend,
			messages,
			"commands",
			"command.list",
			{ surface: "tui" },
			deadlineAt,
		);
		const commandRows = isObject(commands.result) && Array.isArray(commands.result.commands)
			? commands.result.commands
			: [];
		const sessionReady = isObject(bootstrap.result) && typeof bootstrap.result.session_id === "string";
		const completed = sessionReady
			&& commandRows.length === EXPECTED_VISIBLE_COMMANDS
			&& !existsSync(pythonMarker);
		await shutdown(backend);
		backend = undefined;
		writeSummary({
			status: completed ? "completed" : "failed",
			runtime: "node",
			command_count: commandRows.length,
			session_ready: sessionReady,
			python_started: existsSync(pythonMarker),
		});
		return completed ? 0 : 1;
	} catch {
		writeSummary({
			status: "failed",
			runtime: "node",
			command_count: 0,
			session_ready: false,
			python_started: existsSync(pythonMarker),
		});
		return 1;
	} finally {
		reader?.close();
		await backend?.close().catch(() => undefined);
		await rm(root, { recursive: true, force: true });
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
	const code = await backend.completion;
	if (code !== 0) throw new Error("smoke_shutdown_failed");
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

function writeSummary(summary) {
	process.stdout.write(`${JSON.stringify(summary)}\n`);
}

process.exitCode = await main();

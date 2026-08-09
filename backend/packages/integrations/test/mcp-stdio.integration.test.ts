import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	McpClient,
	type McpServerConfig,
} from "../src/index.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-stdio-server.mjs");

test("MCP stdio uses the real SDK for tools, resources, and deterministic cleanup", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-stdio-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const pidFile = join(root, "server.pid");
	const client = new McpClient({
		config: stdioConfig(pidFile, 2_000),
		cwd: root,
		sandboxProfile: fullAccessSandbox(root),
	});

	const tools = await client.listTools(new AbortController().signal);
	const result = await client.callTool("echo", { text: "hello" }, new AbortController().signal);
	const resources = await client.listResources(new AbortController().signal);
	const contents = await client.readResource("file:///README.md", new AbortController().signal);
	const pid = Number(await readFile(pidFile, "utf8"));

	assert.deepEqual(tools.map((tool) => tool.name), ["echo", "wait"]);
	assert.equal(result.content[0]?.text, "echo:hello");
	assert.equal(resources[0]?.uri, "file:///README.md");
	assert.equal(contents[0]?.text, "fixture readme");
	assert.equal(processExists(pid), true);

	await client.close();
	await eventually(() => !processExists(pid));
});

test("MCP stdio timeout rejects the call and closes the child process", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-timeout-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const pidFile = join(root, "server.pid");
	const client = new McpClient({
		config: stdioConfig(pidFile, 500),
		cwd: root,
		sandboxProfile: fullAccessSandbox(root),
	});
	await client.listTools(new AbortController().signal);
	const pid = Number(await readFile(pidFile, "utf8"));

	await assert.rejects(
		() => client.callTool("wait", { delay_ms: 5_000 }, new AbortController().signal),
		/timeout|timed out/iu,
	);
	await eventually(() => !processExists(pid));
});

test("MCP stdio interruption propagates AbortError and closes the child process", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-abort-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const pidFile = join(root, "server.pid");
	const client = new McpClient({
		config: stdioConfig(pidFile, 2_000),
		cwd: root,
		sandboxProfile: fullAccessSandbox(root),
	});
	await client.listTools(new AbortController().signal);
	const pid = Number(await readFile(pidFile, "utf8"));
	const controller = new AbortController();
	const request = client.callTool("wait", { delay_ms: 5_000 }, controller.signal);
	controller.abort();

	await assert.rejects(
		() => request,
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	await eventually(() => !processExists(pid));
});

function stdioConfig(pidFile: string, timeoutMs: number): McpServerConfig {
	return {
		id: "fixture",
		transport: "stdio",
		command: process.execPath,
		args: [fixturePath],
		env: { MCP_PID_FILE: pidFile },
		headers: {},
		enabled: true,
		timeoutMs,
	};
}

function fullAccessSandbox(root: string) {
	return {
		mode: "danger-full-access" as const,
		filesystem: "unrestricted" as const,
		network: "enabled" as const,
		writableRoots: [root],
		workspaceRoot: root,
		cwd: root,
	};
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("condition was not met before timeout");
}

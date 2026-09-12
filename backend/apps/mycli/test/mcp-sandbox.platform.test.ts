import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { McpClient, parseMcpServerConfig } from "@mycli/integrations";
import { mcpSandboxProfile } from "../src/node-runtime/integration-sandbox.ts";

const fixturePath = fileURLToPath(new URL("../../../packages/integrations/test/fixtures/mcp-policy-server.mjs", import.meta.url));
const macOS = { skip: process.platform !== "darwin", timeout: 15_000 };

test("default MCP networking works while outside writes and repository metadata stay protected, including an external cwd", macOS, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-sandbox-"));
	const workspace = join(root, "repo");
	const plugin = join(root, "plugin");
	await mkdir(join(workspace, ".git"), { recursive: true });
	await mkdir(plugin);
	let hits = 0;
	const server = createServer((_request, response) => { hits += 1; response.end("connected"); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
	for (const mode of ["default", "offline", "managed-offline", "readonly"] as const) {
		const config = parseMcpServerConfig("fixture", { command: process.execPath, args: [fixturePath], cwd: plugin,
			sandbox: mode === "readonly" ? { mode: "read-only" } : mode === "offline" ? { network: "disabled" } : {},
			env: { MCP_LOCAL_URL: `http://127.0.0.1:${address.port}/`, MCP_INSIDE: join(workspace, "allowed"),
				MCP_OUTSIDE: join(plugin, "denied"), MCP_METADATA: join(workspace, ".git/denied") } }, {});
		const profile = mcpSandboxProfile(workspace, config, mode === "managed-offline" ? { source: "managed", network: "disabled" } : undefined);
		const client = new McpClient({ config, sandboxProfile: profile });
		t.after(() => client.close());
		const response = await client.callTool("probe", {}, new AbortController().signal);
		const result = JSON.parse(String(response.content[0]?.text)) as Record<string, unknown>;
		assert.equal(result.cwd, await realpath(plugin));
		assert.equal(result.network, mode === "default" || mode === "readonly");
		assert.equal(result.inside, mode !== "readonly");
		assert.equal(result.outside, false);
		assert.equal(result.metadata, false);
		await client.close();
	}
	assert.equal(hits, 2);
});

test("MCP domain proxy belongs to its process generation and closes after timeout, cancellation and shutdown", macOS, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-proxy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const config = parseMcpServerConfig("fixture", { command: process.execPath, args: [fixturePath], startup_timeout_sec: 3, tool_timeout_sec: 0.2 }, {});
	const client = new McpClient({ config, sandboxProfile: mcpSandboxProfile(root, config, { source: "managed", networkDomains: ["example.com"] }) });
	t.after(() => client.close());
	const proxy = async (): Promise<{ readonly port: number; readonly pid: number }> => {
		const response = await client.callTool("probe", {}, new AbortController().signal);
		const result = JSON.parse(String(response.content[0]?.text)) as { proxy: string; pid: number };
		const port = Number(new URL(result.proxy).port);
		assert.equal(await portOpen(port), true);
		return { port, pid: result.pid };
	};
	const first = await proxy();
	await assert.rejects(client.callTool("wait", {}, new AbortController().signal), /timeout/u);
	assert.equal(await portOpen(first.port), false);
	const second = await proxy();
	const controller = new AbortController();
	const waiting = client.callTool("wait", {}, controller.signal);
	controller.abort();
	await assert.rejects(waiting, { name: "AbortError" });
	assert.equal(await portOpen(second.port), false);
	const third = await proxy();
	process.kill(third.pid, "SIGTERM");
	const deadline = Date.now() + 2_000;
	while (await portOpen(third.port) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
	assert.equal(await portOpen(third.port), false);
	const fourth = await proxy();
	assert.notEqual(fourth.pid, third.pid);
	await client.close();
	assert.equal(await portOpen(fourth.port), false);
});

function portOpen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host: "127.0.0.1" });
		socket.once("connect", () => { socket.destroy(); resolve(true); });
		socket.once("error", () => { socket.destroy(); resolve(false); });
	});
}

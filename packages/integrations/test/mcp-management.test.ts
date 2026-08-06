import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	McpManagementService,
	type McpManagedClient,
} from "../src/index.ts";

test("returns provider-free MCP management rows and closes discovery clients", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-management-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	await mkdir(join(workspaceRoot, ".mycli"), { recursive: true });
	await writeFile(join(workspaceRoot, ".mycli", "mcp_servers.toml"), [
		"[servers.files]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
		"timeout_seconds = 2",
		"",
		"[servers.offline]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
		"enabled = false",
	].join("\n"), "utf8");
	let clientCount = 0;
	let closeCount = 0;
	const createClient = (): McpManagedClient => {
		clientCount += 1;
		return {
			listTools: async () => [{
				serverId: "files",
				name: "read_file",
				description: "",
				inputSchema: { type: "object", properties: {} },
			}],
			callTool: async () => ({ content: [], isError: false }),
			listResources: async () => [],
			readResource: async () => [],
			close: async () => { closeCount += 1; },
		};
	};
	const service = new McpManagementService({
		workspaceRoot,
		homeDir,
		env: {},
		createClient,
	});

	const response = await service.list(new AbortController().signal);

	assert.equal(response.ok, true);
	assert.equal(response.action, "list");
	assert.deepEqual(response.servers.map((row) => [row.serverId, row.status]), [
		["files", "ok"],
		["offline", "disabled"],
	]);
	assert.equal(response.servers[0]?.toolCount, 1);
	assert.equal(response.servers[0]?.timeoutMs, 2_000);
	assert.deepEqual(response.issues, []);
	assert.equal(clientCount, 1);
	assert.equal(closeCount, 1);
});

test("bounds management failures and usage does not initialize an MCP client", async () => {
	let clientCount = 0;
	const service = new McpManagementService({
		workspaceRoot: "/missing-workspace",
		homeDir: "/missing-home",
		env: {},
		createClient: () => {
			clientCount += 1;
			throw new Error("token=private-value");
		},
	});

	const usage = service.usage();
	const inspect = await service.inspect("missing", new AbortController().signal);

	assert.equal(usage.action, "usage");
	assert.equal(usage.ok, true);
	assert.equal(clientCount, 0);
	assert.equal(inspect.ok, false);
	assert.equal(inspect.action, "inspect");
	assert.equal(JSON.stringify(inspect).includes("private-value"), false);
});

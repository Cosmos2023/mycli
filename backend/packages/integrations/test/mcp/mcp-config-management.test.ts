import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { McpConfigStore, McpManagementService, discoverMcpConfig, parseMcpServerConfig } from "../../src/index.ts";

test("MCP configuration supports separate deadlines, filters, approval precedence and environment headers", () => {
	const config = parseMcpServerConfig("docs", { url: "https://example.com/mcp", cwd: "tools", required: true,
		startup_timeout_sec: 2.5, tool_timeout_sec: 80, enabled_tools: ["read", "write"], disabled_tools: ["write"],
		default_tools_approval_mode: "prompt", tools: { read: { approval_mode: "approve" } },
		sandbox: { mode: "read-only", network: "enabled" }, env_vars: ["VALUE"], env: { VALUE: "override" },
		http_headers: { Authorization: "old" }, headers: { authorization: "replacement" },
		env_http_headers: { "X-Account": "ACCOUNT" }, bearer_token_env_var: "TOKEN",
	}, { VALUE: "inherited", ACCOUNT: "fixture-account", TOKEN: "private-value" });
	assert.equal(config.transport, "streamable_http");
	assert.equal(config.startupTimeoutMs, 2_500);
	assert.equal(config.toolTimeoutMs, 80_000);
	assert.equal(config.timeoutMs, 30_000);
	assert.equal(config.tools?.read?.approvalMode, "approve");
	assert.deepEqual(config.env, { VALUE: "override" });
	assert.deepEqual(config.headers, { Authorization: "Bearer private-value", "X-Account": "fixture-account" });
	for (const field of [{ tool_timeout_sec: 301 }, { startup_timeout_sec: 0 }, { enabled_tools: "read" },
		{ sandbox: { network: "maybe" } }, { tools: { read: { approval_mode: "yes" } } },
		{ required: "true" }, { env: { A: "\0" } }, { headers: { Test: "a\nb" } }]) {
		assert.throws(() => parseMcpServerConfig("test", { command: "node", ...field }, {}));
	}
});

test("MCP config edits are atomic, private, preserve aliases and never instantiate a client", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-config-edit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".mycli"));
	const path = join(root, ".mycli/mcp_servers.toml");
	await writeFile(path, 'custom = "retained"\n[mcpServers.old]\ncommand = "old-command"\n');
	const store = new McpConfigStore({ homeDir: root, env: {} });
	const signal = new AbortController().signal;
	await Promise.all(["alpha", "beta"].map((id) => store.add(id, { command: "never-start", args: ["--json"] }, signal)));
	const document = parse(await readFile(path, "utf8"));
	assert.equal(document.custom, "retained");
	assert.deepEqual(Object.keys(document.mcpServers as object).sort(), ["alpha", "beta", "old"]);
	if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
	await assert.rejects(store.add("old", { command: "replacement" }, signal), /mcp_server_exists/u);
	const original = await readFile(path, "utf8");
	await assert.rejects(store.remove("old", AbortSignal.abort()));
	assert.equal(await readFile(path, "utf8"), original);
	const service = new McpManagementService({ homeDir: root, workspaceRoot: join(root, "workspace"), env: {},
		createClient: () => assert.fail("editing must not execute any configured command") });
	assert.equal((await service.add("safe", { command: "not-executed" }, signal)).ok, true);
	assert.equal((await service.remove("safe", signal)).ok, true);
	assert.equal((await service.remove("missing", signal)).ok, false);
	assert.equal((await service.add("bad", { command: "private-command", headers: { A: 2 } }, signal)).ok, false);
	await writeFile(path, "x".repeat(1_048_577));
	await assert.rejects(store.add("oversized", { command: "node" }, signal), /mcp_config_too_large/u);
	assert.equal((await stat(path)).size, 1_048_577);
});

test("required config failures stay visible and repository overrides are reported after user edits", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-config-required-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspaceRoot = join(root, "repo");
	await mkdir(join(workspaceRoot, ".mycli"), { recursive: true });
	await writeFile(join(workspaceRoot, ".mycli/mcp_servers.toml"), '[servers.docs]\ncommand = "repo-command"\ncwd = "tools"\n[servers.broken]\nrequired = true\ncommand = 12\n');
	const options = { homeDir: root, workspaceRoot, env: {}, createClient: () => assert.fail("must not launch") };
	const config = await discoverMcpConfig(options);
	assert.equal(config.get("docs")?.cwd, join(workspaceRoot, "tools"));
	assert.equal(config.diagnostics[0]?.required, true);
	const response = await new McpManagementService(options).add("docs", { command: "user-command" }, new AbortController().signal);
	assert.equal(response.ok, true);
	assert.match(response.message, /Repository configuration remains active/u);
	const userOnly = await discoverMcpConfig({ ...options, includeRepository: false });
	const otherWorkspace = await discoverMcpConfig({ ...options, workspaceRoot: join(root, "other"), includeRepository: false });
	assert.equal(userOnly.get("docs")?.cwd, workspaceRoot);
	assert.notEqual(otherWorkspace.get("docs")?.cwd, userOnly.get("docs")?.cwd);
});

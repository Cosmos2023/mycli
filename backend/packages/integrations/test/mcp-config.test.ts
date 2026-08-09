import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { discoverMcpConfig } from "../src/index.ts";

test("loads all MCP root aliases with repository precedence and environment resolution", async (t) => {
	const fixture = await configFixture(t);
	await writeConfig(fixture.homeDir, [
		"[mcpServers.local]",
		'type = "stdio"',
		'command = "ignored-user-command"',
		'args = ["user.mjs"]',
		"",
		"[mcpServers.remote]",
		'type = "streamable-http"',
		'url = "https://remote.example.test/mcp"',
		'env = { ACCESS_TOKEN = "${MCP_ACCESS_TOKEN}" }',
		'headers = { Authorization = "${MCP_ACCESS_TOKEN}" }',
	]);
	await writeConfig(fixture.workspaceRoot, [
		"[servers.local]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
		'args = ["repo.mjs"]',
		"timeout_seconds = 3",
		"",
		"[mcp_servers.legacy]",
		'transport = "http"',
		'url = "https://legacy.example.test/rpc"',
		"enabled = false",
	]);

	const discovery = await discoverMcpConfig({
		workspaceRoot: fixture.workspaceRoot,
		homeDir: fixture.homeDir,
		env: { MCP_ACCESS_TOKEN: "private-token" },
	});

	assert.deepEqual(discovery.servers.map((server) => [server.id, server.transport]), [
		["legacy", "http"],
		["local", "stdio"],
		["remote", "streamable_http"],
	]);
	assert.equal(discovery.get("local")?.command, process.execPath);
	assert.deepEqual(discovery.get("local")?.args, ["repo.mjs"]);
	assert.equal(discovery.get("local")?.timeoutMs, 3_000);
	assert.equal(discovery.get("legacy")?.enabled, false);
	assert.deepEqual(discovery.get("remote")?.env, { ACCESS_TOKEN: "private-token" });
	assert.deepEqual(discovery.get("remote")?.headers, { Authorization: "private-token" });
	assert.equal(discovery.diagnostics.length, 0);
});

test("isolates malformed MCP rows and emits only bounded non-sensitive diagnostics", async (t) => {
	const fixture = await configFixture(t);
	await writeConfig(fixture.homeDir, [
		"[servers.valid]",
		'transport = "stdio"',
		'command = "node"',
		"",
		"[servers.missing_command]",
		'transport = "stdio"',
		"",
		"[servers.missing_url]",
		'transport = "streamable_http"',
		"",
		'[servers."bad/name"]',
		'transport = "stdio"',
		'command = "node"',
		"",
		"[servers.bad_args]",
		'transport = "stdio"',
		'command = "do-not-leak-command"',
		'args = "not-a-list"',
		"",
		"[servers.bad_timeout]",
		'transport = "stdio"',
		'command = "node"',
		"timeout_seconds = 0",
		"",
		"[servers.missing_env]",
		'transport = "stdio"',
		'command = "node"',
		'env = { SECRET_TOKEN = "${MISSING_PRIVATE_TOKEN}" }',
		"",
		"[servers.bad_remote]",
		'transport = "streamable_http"',
		'url = "file:///private/path"',
		'headers = { Authorization = "Bearer private-value" }',
		"",
		"[mcp_servers.valid]",
		'transport = "stdio"',
		'command = "duplicate-command"',
	]);

	const discovery = await discoverMcpConfig({
		workspaceRoot: fixture.workspaceRoot,
		homeDir: fixture.homeDir,
		env: {},
	});
	const serialized = JSON.stringify(discovery.diagnostics);

	assert.deepEqual(discovery.servers.map((server) => server.id), ["valid"]);
	assert.deepEqual(
		discovery.diagnostics.map((issue) => issue.errorClass).sort(),
		[
			"duplicate_server",
			"invalid_args",
			"invalid_server_id",
			"invalid_timeout",
			"invalid_url",
			"missing_command",
			"missing_environment",
			"missing_url",
		].sort(),
	);
	for (const secret of [
		"do-not-leak-command",
		"MISSING_PRIVATE_TOKEN",
		"file:///private/path",
		"Bearer private-value",
		"duplicate-command",
	]) {
		assert.equal(serialized.includes(secret), false);
	}
	for (const issue of discovery.diagnostics) {
		assert.deepEqual(
			Object.keys(issue).sort(),
			["errorClass", "fileLabel", "serverId", "source"],
		);
	}
});

test("keeps a valid repository config when the user TOML is malformed", async (t) => {
	const fixture = await configFixture(t);
	await mkdir(join(fixture.homeDir, ".mycli"), { recursive: true });
	await writeFile(
		join(fixture.homeDir, ".mycli", "mcp_servers.toml"),
		"[servers.invalid\nsecret = 'must-not-leak'",
		"utf8",
	);
	await writeConfig(fixture.workspaceRoot, [
		"[servers.repo]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
	]);

	const discovery = await discoverMcpConfig(fixture);

	assert.deepEqual(discovery.servers.map((server) => server.id), ["repo"]);
	assert.equal(discovery.diagnostics[0]?.errorClass, "invalid_toml");
	assert.equal(JSON.stringify(discovery.diagnostics).includes("must-not-leak"), false);
});

async function configFixture(t: TestContext): Promise<{
	readonly root: string;
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly env: Readonly<Record<string, string>>;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-config-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return {
		root,
		homeDir: join(root, "home"),
		workspaceRoot: join(root, "workspace"),
		env: {},
	};
}

async function writeConfig(root: string, lines: readonly string[]): Promise<void> {
	await mkdir(join(root, ".mycli"), { recursive: true });
	await writeFile(join(root, ".mycli", "mcp_servers.toml"), lines.join("\n"), "utf8");
}

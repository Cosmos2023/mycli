import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpClient, parseMcpServerConfig } from "@mycli/integrations";
import { prepareSandboxedProcess, ProcessSandboxError } from "@mycli/tools";
import { mcpSandboxProfile } from "../src/node-runtime/integration-sandbox.ts";

test("ordinary MCP launches directly even when the Shell sandbox backend is unavailable", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-launch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const config = parseMcpServerConfig("browser", { command: process.execPath, args: ["server.mjs"] }, {});
	const argv = [config.command!, ...config.args];
	for (const platform of ["darwin", "linux", "win32"] as const) {
		const launch = prepareSandboxedProcess(argv, mcpSandboxProfile(root, config), { platform, isExecutable: () => false });
		assert.deepEqual(launch, { executable: process.execPath, args: ["server.mjs"], isolation: "host_subprocess" });
	}
});

test("explicit and managed MCP restrictions still require their sandbox backend", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-restricted-"));
	const allowed = join(root, "allowed");
	await mkdir(allowed);
	t.after(() => rm(root, { recursive: true, force: true }));
	const config = parseMcpServerConfig("browser", { command: process.execPath }, {});
	const profiles = [
		mcpSandboxProfile(root, { ...config, sandbox: { mode: "workspace-write" } }),
		mcpSandboxProfile(root, { ...config, sandbox: { mode: "read-only" } }),
		mcpSandboxProfile(root, { ...config, sandbox: { network: "disabled" } }),
		mcpSandboxProfile(root, config, { source: "managed", writableRoots: [allowed] }),
		mcpSandboxProfile(root, config, { source: "managed", network: "disabled" }),
		mcpSandboxProfile(root, config, { source: "runtime", networkDomains: ["example.com"] }),
	];
	for (const profile of profiles) {
		assert.throws(() => prepareSandboxedProcess([process.execPath], profile, { platform: "darwin", isExecutable: () => false }),
			(error: unknown) => error instanceof ProcessSandboxError && error.kind === "sandbox_unavailable");
	}
});

test("MCP readable-root bounds cannot silently become unrestricted host execution", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-read-bound-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const config = parseMcpServerConfig("browser", { command: process.execPath }, {});
	const client = new McpClient({ config, sandboxProfile: mcpSandboxProfile(root, config, { source: "managed", readableRoots: [root] }) });
	t.after(() => client.close());
	await assert.rejects(client.listTools(new AbortController().signal), /sandbox_unavailable/u);
});

test("managed denied reads force stdio MCP into the same restricted launch policy", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-mcp-denied-read-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const config = parseMcpServerConfig("browser", { command: process.execPath }, {});
	const profile = mcpSandboxProfile(root, config, { source: "managed", deniedReadRoots: [join(root, "secret")] });
	assert.equal(profile.mode, "workspace-write");
	assert.deepEqual(profile.deniedReadRoots, [join(root, "secret")]);
	assert.throws(() => prepareSandboxedProcess([process.execPath], profile, { platform: "darwin" }), /Denied-read rules/u);
});

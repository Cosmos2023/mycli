import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freezeNetworkEgress } from "@mycli/core";
import { parseMcpServerConfig, type LoadedPluginManifest } from "@mycli/integrations";
import { McpClient } from "@mycli/integrations/mcp";
import { prepareSandboxedProcess, ProcessSandboxError } from "@mycli/tools";
import { mcpSandboxProfile, pluginSandboxProfile, workspaceSandboxProfile } from "../src/node-runtime/integration-sandbox.ts";

test("managed egress retains offline hook, plugin and MCP launches without enabling network", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-offline-egress-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const networkEgress = freezeNetworkEgress({ default: "deny", allow: [{ to: [{ cidr: "10.0.0.0/8" }] }] });
	const constraints = { source: "managed" as const, networkEgress };
	const manifest: LoadedPluginManifest = {
		api_version: 2, id: "offline", name: "Offline", entry: "index.mjs", requires_env: [], capabilities: [],
		provides: { tools: [], hooks: [], commands: [] }, source: "repo", pluginRoot: root,
		manifestPath: join(root, "plugin.json"), entryPath: join(root, "index.mjs"),
	};
	const config = parseMcpServerConfig("offline", { command: process.execPath, sandbox: { network: "disabled" } }, {});
	for (const profile of [workspaceSandboxProfile(root, root, constraints), pluginSandboxProfile(manifest, constraints),
		mcpSandboxProfile(root, config, constraints)]) {
		assert.equal(profile.network, "disabled");
		assert.equal(profile.networkEgress, undefined);
		const launch = prepareSandboxedProcess([process.execPath], profile, {
			platform: "win32", windowsHelperPath: join(root, "helper.exe"), isExecutable: () => true,
		});
		assert.equal(launch.isolation, "windows_native");
		assert.equal(JSON.parse(launch.args[1]!).network, "disabled");
		assert.equal(JSON.parse(launch.args[1]!).network_egress, undefined);
	}
	for (const profile of [pluginSandboxProfile({ ...manifest, capabilities: ["network"] }, constraints),
		mcpSandboxProfile(root, { ...config, sandbox: { network: "enabled" } }, constraints)]) {
		assert.equal(profile.network, "enabled");
		assert.deepEqual(profile.networkEgress, networkEgress);
	}
});

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
	const profile = mcpSandboxProfile(root, config, { source: "managed", readableRoots: [root] });
	if (process.platform === "win32") {
		const probes = { platform: "win32" as const, windowsHelperPath: join(root, "helper.exe"), isExecutable: () => true };
		const launch = prepareSandboxedProcess([process.execPath], profile, probes);
		assert.equal(launch.isolation, "windows_native");
		assert.equal(launch.executable, probes.windowsHelperPath);
		assert.deepEqual(JSON.parse(launch.args[1]!).readable_roots, [root]);
		assert.throws(() => prepareSandboxedProcess([process.execPath], profile, { ...probes, isExecutable: () => false }),
			(error: unknown) => error instanceof ProcessSandboxError && error.kind === "sandbox_unavailable");
		return;
	}
	const client = new McpClient({ config, sandboxProfile: profile });
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

test("integration process profiles carry port limits while explicit offline policy wins", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-integration-ports-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const constraints = { source: "managed" as const, networkDomains: ["example.com"], loopbackPorts: [5432] };
	const manifest: LoadedPluginManifest = {
		api_version: 2, id: "ports", name: "Ports", entry: "index.mjs", requires_env: [], capabilities: ["network"],
		provides: { tools: [], hooks: [], commands: [] }, source: "repo", pluginRoot: root,
		manifestPath: join(root, "plugin.json"), entryPath: join(root, "index.mjs"),
	};
	const config = parseMcpServerConfig("ports", { command: process.execPath }, {});
	for (const profile of [pluginSandboxProfile(manifest, constraints), mcpSandboxProfile(root, config, constraints),
		workspaceSandboxProfile(root, root, constraints), pluginSandboxProfile({ ...manifest, capabilities: [] }, constraints),
		mcpSandboxProfile(root, { ...config, sandbox: { network: "disabled" } }, constraints)]) {
		assert.deepEqual(profile.loopbackPorts, [5432]);
		assert.ok(Object.isFrozen(profile.loopbackPorts));
		const launch = prepareSandboxedProcess([process.execPath], profile, { platform: "win32", isExecutable: () => true },
			profile.network === "enabled" ? { port: 40000 } : undefined);
		const request = JSON.parse(launch.args[1]!);
		assert.deepEqual(request.loopback_ports, [5432]);
		assert.equal(request.network, profile.network);
		assert.equal(request.network_proxy_port, profile.network === "enabled" ? 40000 : undefined);
	}
});

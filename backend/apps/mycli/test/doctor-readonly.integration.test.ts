import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const mcpFixture = new URL("../../../packages/integrations/test/fixtures/mcp-stdio-server.mjs", import.meta.url).href;

test("compiled Doctor and repair preview inspect extensions without starting their processes", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-doctor-readonly-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const configRoot = join(homeDir, ".mycli");
	const pluginRoot = join(configRoot, "plugins", "probe");
	await mkdir(pluginRoot, { recursive: true });
	await mkdir(workspaceRoot);
	const mcpMarker = join(workspaceRoot, "mcp-started");
	const pluginMarker = join(workspaceRoot, "plugin-started");
	const mcpScript = join(root, "mcp.mjs");
	await writeFile(mcpScript, [
		'import { writeFileSync } from "node:fs";',
		`writeFileSync(${JSON.stringify(mcpMarker)}, String(process.pid));`,
		`await import(${JSON.stringify(mcpFixture)});`,
	].join("\n"));
	await writeFile(join(pluginRoot, "index.mjs"), [
		'import { writeFileSync } from "node:fs";',
		`writeFileSync(${JSON.stringify(pluginMarker)}, "started");`,
		"export function register() {}",
	].join("\n"));
	await writeFile(join(pluginRoot, "plugin.yaml"), [
		"api_version: 2", "id: probe", "name: Probe", "entry: index.mjs",
		"provides:", "  tools: []", "  hooks: []", "  commands: []",
		"requires_env: []", "capabilities: [filesystem_write]",
	].join("\n"));
	await writeFile(join(configRoot, "config.toml"), '[plugins]\nenabled = ["probe"]\n');
	await writeFile(join(configRoot, "mcp_servers.toml"), [
		"[mcpServers.probe]", 'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
		`args = ${JSON.stringify([mcpScript])}`, "startup_timeout_sec = 3",
	].join("\n"));
	const initialFiles = await readdir(configRoot);
	const run = (args: readonly string[]): { readonly checks?: readonly { readonly name: string; readonly status: string; readonly message: string }[];
		readonly servers?: readonly { readonly status: string; readonly toolCount: number }[] } => {
		const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
			cwd: workspaceRoot,
			env: { PATH: process.env.PATH, HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: "1", TERM: "dumb" },
			timeout: 8_000, encoding: "utf8", maxBuffer: 2 * 1_024 * 1_024,
		});
		assert.equal(result.error, undefined);
		assert.ok(result.status === 0 || (args[0] === "doctor" && result.status === 1), result.stderr);
		return JSON.parse(result.stdout) as ReturnType<typeof run>;
	};
	for (const args of [["doctor"], ["doctor", "--fix"], ["doctor", "--support-bundle"]]) {
		const result = run(args);
		assert.deepEqual({ mcpStarted: existsSync(mcpMarker), pluginStarted: existsSync(pluginMarker) },
			{ mcpStarted: false, pluginStarted: false }, args.join(" "));
		for (const name of ["plugins", "mcp"]) {
			const check = result.checks?.find((item) => item.name === name);
			assert.equal(check?.status, "ok");
			assert.match(check?.message ?? "", /runtime=not_probed/u);
		}
		assert.deepEqual((await readdir(configRoot)).filter((name) => name !== "support"), initialFiles);
	}
	const inspected = run(["mcp", "inspect", "probe"]);
	assert.equal(inspected.servers?.[0]?.status, "ok");
	assert.equal(inspected.servers?.[0]?.toolCount, 2);
	assert.equal(existsSync(mcpMarker), true, "explicit MCP inspection still starts the live server");
	assert.equal(existsSync(pluginMarker), false);
	const pid = Number(await readFile(mcpMarker, "utf8"));
	assert.ok(Number.isSafeInteger(pid) && pid > 0);
	assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && "code" in error && error.code === "ESRCH");
});

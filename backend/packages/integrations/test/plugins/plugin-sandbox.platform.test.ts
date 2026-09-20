import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareSandboxedProcess } from "@mycli/tools";
import { loadPluginManifest, PluginHostError, PluginProcessHost } from "../../src/index.ts";
import { removeFixtureDirectoryAfterTests } from "../../../storage/test/fixtures/directory-cleanup.ts";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };

for (const source of [true, false]) {
	test(`Windows ${source ? "source" : "compiled"} plugin starts with runtime reads and retains isolation`, windows, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "mycli-plugin-isolation-"));
		removeFixtureDirectoryAfterTests(t, root);
		const pluginRoot = join(root, "sandbox");
		await mkdir(pluginRoot);
		const outside = join(root, "outside.txt");
		await writeFile(outside, "private fixture");
		await copyFile(new URL("../fixtures/plugins/sandbox.mjs", import.meta.url), join(pluginRoot, "index.mjs"));
		await writeFile(join(pluginRoot, "plugin.yaml"), ["api_version: 2", "id: sandbox", "name: Sandbox fixture",
			"entry: index.mjs", "provides:", "  tools: []", "  hooks: []", "  commands: [probe]",
			"requires_env: []", "capabilities: [filesystem_write]"].join("\n"));
		const loaded = await loadPluginManifest({ pluginRoot, source: "repo" });
		assert.ok(loaded.kind === "loaded");
		const Host = source ? PluginProcessHost : (await import("../../dist/plugins/process-host.js")).PluginProcessHost;
		const host = new Host({ manifest: loaded.manifest, env: { ...process.env, MYCLI_API_KEY: "fixture-secret" },
			sandboxProfile: { mode: "workspace-write", filesystem: "workspace_write", network: "disabled",
				workspaceRoot: pluginRoot, cwd: pluginRoot, writableRoots: [pluginRoot] } });
		try {
			assert.equal((await host.start(AbortSignal.timeout(10_000))).length, 1);
			const result = await host.invoke("command:probe", { outside, runtime: fileURLToPath(new URL(
				source ? "../../src/plugins/worker-bootstrap.ts" : "../../dist/plugins/worker-bootstrap.js", import.meta.url)) },
				AbortSignal.timeout(10_000));
			assert.equal(result.value.ok, true);
			assert.deepEqual(result.value.metadata, { outsideReadable: false, parentListable: false,
				runtimeWritable: false, hasSecret: false });
			assert.equal(await readFile(join(pluginRoot, "inside.txt"), "utf8"), "allowed");
			assert.equal(await readFile(outside, "utf8"), "private fixture");
			if (source) {
				const runWriter = async (workspaceRoot: string): Promise<void> => {
					const launch = prepareSandboxedProcess([process.execPath, "-e",
						"require('node:fs').writeFileSync('writer.txt','allowed')"], {
						mode: "workspace-write", filesystem: "workspace_write", network: "disabled",
						workspaceRoot, cwd: workspaceRoot, writableRoots: [workspaceRoot],
					});
					await promisify(execFile)(launch.executable, [...launch.args], {
						cwd: workspaceRoot, env: { ...process.env, ...launch.env }, timeout: 10_000,
					});
				};
				// PSEC policies are enforced per command, so a workspace-wide writer may
				// run beside the plugin host instead of being rejected (Codex parity).
				await runWriter(root);
				assert.equal(await readFile(join(root, "writer.txt"), "utf8"), "allowed");
				const disjoint = join(root, "disjoint");
				await mkdir(disjoint);
				await runWriter(disjoint);
				assert.equal(await readFile(join(disjoint, "writer.txt"), "utf8"), "allowed");
			}
		} finally {
			await host.close();
		}
	});
}

test("Windows explicit runtime denial prevents plugin startup", windows, async () => {
	const pluginRoot = fileURLToPath(new URL("../fixtures/plugins/good", import.meta.url));
	const loaded = await loadPluginManifest({ pluginRoot, source: "repo" });
	assert.ok(loaded.kind === "loaded");
	const host = new PluginProcessHost({ manifest: loaded.manifest,
		sandboxProfile: { mode: "read-only", filesystem: "read_only", network: "disabled", writableRoots: [],
			workspaceRoot: pluginRoot, cwd: pluginRoot,
			deniedReadRoots: [fileURLToPath(new URL("../../src/plugins/worker-bootstrap.ts", import.meta.url))] } });
	try {
		await assert.rejects(host.start(AbortSignal.timeout(10_000)),
			(error: unknown) => error instanceof PluginHostError && error.kind === "worker_exited");
	} finally { await host.close(); }
});
